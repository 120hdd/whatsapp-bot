import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from 'pino';

import type { AppConfig } from '../config/schema.js';
import { DeliveryError } from '../domain/errors.js';
import { asSendableJob, type QueueJob } from '../domain/jobs.js';
import type { Clock } from '../domain/types.js';
import { systemClock } from '../domain/types.js';
import {
  AuditRepository,
  DestinationRepository,
  JobRepository,
  StateRepository,
} from '../db/repositories/index.js';
import { decideRetry } from './retry-policy.js';
import type { MessageTransport } from './transport.js';

export class QueueWorker {
  private stopping = false;
  private running = false;
  private lastSendFinishedAt = 0;

  public constructor(
    private readonly jobs: JobRepository,
    private readonly destinations: DestinationRepository,
    private readonly state: StateRepository,
    private readonly audit: AuditRepository,
    private readonly transport: MessageTransport,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
    private readonly random: () => number = Math.random,
  ) {}

  public get isRunning(): boolean {
    return this.running;
  }

  public requestStop(): void {
    this.stopping = true;
  }

  public async run(): Promise<void> {
    this.running = true;
    this.state.set('worker_state', 'RUNNING');
    try {
      while (!this.stopping) {
        const processed = await this.processOnce();
        if (!processed) await sleep(this.config.workerPollMs);
      }
    } finally {
      this.running = false;
      this.state.set('worker_state', 'STOPPED');
    }
  }

  public async processOnce(): Promise<boolean> {
    if (this.isGloballyPaused()) return false;
    const now = this.clock.now().toISOString();
    this.jobs.promoteDueScheduled(now);
    this.jobs.cancelDisabled();
    const job = this.jobs.claimNext(now);
    if (!job) return false;
    this.logger.info(
      { job_id: job.uuid, destination_jid: job.destinationJid, attempt: job.attemptCount },
      'job_claimed',
    );
    if (!(await this.pace())) {
      this.jobs.transition(job.uuid, 'RETRY', {
        nextAttemptAt: this.clock.now().toISOString(),
        errorClass: 'SHUTDOWN_BEFORE_SEND',
        errorMessage: 'Worker stopped before transport invocation',
      });
      return true;
    }
    const destination = this.destinations.resolve(job.destinationJid);
    if (!destination?.enabled || !destination.canSend) {
      this.jobs.transition(job.uuid, 'FAILED', {
        errorClass: 'DESTINATION_ERROR',
        errorMessage: 'Destination was disabled before delivery',
        auditEvent: 'delivery_permanent_failure',
      });
      return true;
    }
    if (job.mediaPath && !existsSync(job.mediaPath)) {
      this.jobs.transition(job.uuid, 'FAILED', {
        errorClass: 'MEDIA_ERROR',
        errorMessage: 'Staged media no longer exists',
        auditEvent: 'delivery_permanent_failure',
      });
      return true;
    }

    try {
      const result = await this.transport.send(asSendableJob(job));
      if (result.dryRun) {
        this.jobs.transition(job.uuid, 'DRY_RUN', {
          remoteMessageId: result.remoteMessageId,
          auditEvent: 'dry_run_executed',
        });
      } else {
        this.jobs.transition(job.uuid, 'SENT', {
          remoteMessageId: result.remoteMessageId,
          auditEvent: 'delivery_succeeded',
        });
        this.state.set('last_successful_send_at', this.clock.now().toISOString());
      }
      this.state.set('connectivity', this.transport.name === 'dry-run' ? 'OFFLINE_DRY_RUN' : 'CONNECTED');
      this.logger.info(
        {
          job_id: job.uuid,
          destination_jid: job.destinationJid,
          attempt: job.attemptCount,
          simulated: result.dryRun,
        },
        result.dryRun ? 'message_dry_run' : 'message_sent',
      );
    } catch (error) {
      const deliveryError =
        error instanceof DeliveryError
          ? error
          : new DeliveryError('UNKNOWN_TRANSIENT', 'Unexpected transport failure', { cause: error });
      this.handleError(job, deliveryError);
    } finally {
      this.lastSendFinishedAt = Date.now();
    }
    return true;
  }

  private handleError(job: QueueJob, error: DeliveryError): void {
    const decision = decideRetry({
      errorClass: error.errorClass,
      attempt: job.attemptCount,
      maxAttempts: job.maxAttempts,
      baseMs: this.config.retryBaseMs,
      maxMs: this.config.retryMaxMs,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      random: this.random,
    });
    const context = {
      job_id: job.uuid,
      destination_jid: job.destinationJid,
      attempt: job.attemptCount,
      error_class: error.errorClass,
    };
    if (decision.action === 'retry' || decision.action === 'rate-limit') {
      const next = new Date(this.clock.now().valueOf() + (decision.delayMs ?? 0)).toISOString();
      this.jobs.transition(job.uuid, decision.action === 'rate-limit' ? 'WAITING_RATE_LIMIT' : 'RETRY', {
        nextAttemptAt: next,
        errorClass: error.errorClass,
        errorMessage: error.message,
        auditEvent:
          decision.action === 'rate-limit' ? 'delivery_rate_limited' : 'delivery_retry_scheduled',
      });
      if (decision.action === 'rate-limit') {
        this.state.set('outgoing_pause_until', next);
        this.state.set('outgoing_pause_reason', 'RATE_LIMITED');
      }
      this.logger.warn({ ...context, next_attempt_at: next }, 'message_retry_scheduled');
      return;
    }
    if (decision.action === 'pause-auth') {
      const next = new Date(this.clock.now().valueOf() + (decision.delayMs ?? 0)).toISOString();
      this.jobs.transition(job.uuid, 'RETRY', {
        nextAttemptAt: next,
        errorClass: error.errorClass,
        errorMessage: error.message,
        auditEvent: 'delivery_paused_auth',
      });
      this.state.set('connectivity', error.errorClass === 'LOGGED_OUT' ? 'LOGGED_OUT' : 'AUTH_REQUIRED');
      this.state.set('outgoing_pause_reason', error.errorClass);
      this.audit.add('auth_required', {
        actor: 'worker',
        entityType: 'job',
        entityId: job.uuid,
      });
      this.requestStop();
      this.logger.error(context, 'worker_paused_for_authentication');
      return;
    }
    if (error.errorClass === 'PERMISSION_ERROR' || error.errorClass === 'DESTINATION_ERROR') {
      this.destinations.setCanSend(job.destinationJid, false);
    }
    this.jobs.transition(job.uuid, 'FAILED', {
      errorClass: error.errorClass,
      errorMessage: error.message,
      auditEvent: 'delivery_permanent_failure',
    });
    this.logger.error(context, 'message_failed');
  }

  private isGloballyPaused(): boolean {
    if (this.transport.name === 'dry-run') return false;
    const reason = this.state.get('outgoing_pause_reason');
    if (reason === 'AUTH_REQUIRED' || reason === 'LOGGED_OUT' || reason === 'FATAL') return true;
    const until = this.state.get('outgoing_pause_until');
    if (!until) return false;
    if (new Date(until).valueOf() > this.clock.now().valueOf()) return true;
    this.state.remove('outgoing_pause_until');
    if (reason === 'RATE_LIMITED') this.state.remove('outgoing_pause_reason');
    return false;
  }

  private async pace(): Promise<boolean> {
    if (this.config.sendIntervalMs <= 0 || this.lastSendFinishedAt === 0) return !this.stopping;
    const waitMs = Math.max(0, this.config.sendIntervalMs - (Date.now() - this.lastSendFinishedAt));
    if (waitMs === 0) return !this.stopping;
    const deadline = Date.now() + waitMs;
    while (!this.stopping && Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
    }
    return !this.stopping;
  }
}

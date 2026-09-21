import { once } from 'node:events';

import type { AppConfig } from './config/schema.js';
import { ensureApplicationDirectories } from './config/load.js';
import { createAppContext } from './app-context.js';
import { ProcessLock } from './lock/process-lock.js';
import { DryRunTransport } from './messaging/dry-run-transport.js';
import { QueueWorker } from './messaging/queue-worker.js';
import type { MessageTransport } from './messaging/transport.js';
import { ConnectionManager } from './whatsapp/connection-manager.js';
import { createControllerExecutor } from './whatsapp/controller-commands.js';
import { WhatsAppGroupService } from './whatsapp/group-service.js';
import { SelfChatController } from './whatsapp/self-controller.js';
import { BaileysTransport } from './whatsapp/transport.js';

export type DaemonExit = 'STOPPED' | 'AUTH_REQUIRED';

export async function runDaemon(config: AppConfig): Promise<DaemonExit> {
  ensureApplicationDirectories(config);
  const lock = new ProcessLock(config.lockPath);
  lock.acquire();
  const context = createAppContext(config);
  let connection: ConnectionManager | null = null;
  let controller: SelfChatController | null = null;
  let worker: QueueWorker | null = null;
  let workerTask: Promise<void> | null = null;
  try {
    context.audit.add('startup', { actor: 'daemon', details: { dryRun: config.dryRun } });
    context.logger.info({ dry_run: config.dryRun }, 'application_started');
    const recovered = context.jobs.recoverStaleProcessing();
    if (recovered > 0) {
      context.logger.warn({ recovered_jobs: recovered }, 'stale_jobs_require_review');
    }

    let transport: MessageTransport;
    if (config.dryRun) {
      context.state.set('connectivity', 'OFFLINE_DRY_RUN');
      context.logger.warn('DRY RUN ACTIVE — outbound WhatsApp sending is disabled');
      transport = new DryRunTransport();
    } else {
      if (!context.auth.hasCredentials()) {
        context.state.set('connectivity', 'AUTH_REQUIRED');
        context.state.set('outgoing_pause_reason', 'AUTH_REQUIRED');
        context.audit.add('auth_required', { actor: 'daemon' });
        context.logger.error('WhatsApp login required; run `wts auth login`');
        return 'AUTH_REQUIRED';
      }
      connection = new ConnectionManager(
        context.auth,
        context.state,
        context.audit,
        config,
        context.logger,
      );
      try {
        await connection.connect({ autoReconnect: true });
      } catch (error) {
        if (connection.state === 'LOGGED_OUT' || connection.state === 'AUTH_REQUIRED') {
          context.logger.error('WhatsApp authentication is invalid; run `wts auth login`');
          return 'AUTH_REQUIRED';
        }
        throw error;
      }
      const groups = new WhatsAppGroupService(() => connection?.currentSocket ?? null, context.destinations);
      try {
        await groups.refresh('startup');
      } catch (error) {
        context.logger.warn({ err: error }, 'group_refresh_failed_existing_cache_preserved');
      }
      transport = new BaileysTransport(() => connection?.currentSocket ?? null);
      if (config.selfControllerEnabled && connection.currentSocket) {
        const ownJids = [context.state.get('own_jid'), context.state.get('own_lid')].filter(
          (value): value is string => Boolean(value),
        );
        controller = new SelfChatController(
          connection.currentSocket,
          ownJids,
          context.controller,
          createControllerExecutor(context, groups),
          context.logger,
        );
        controller.register();
      }
    }

    worker = new QueueWorker(
      context.jobs,
      context.destinations,
      context.state,
      context.audit,
      transport,
      config,
      context.logger,
    );
    workerTask = worker.run();
    const signalPromise = Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')]);
    await Promise.race([workerTask, signalPromise]);
    worker.requestStop();
    await workerTask;
    return 'STOPPED';
  } finally {
    controller?.unregister();
    worker?.requestStop();
    if (workerTask) await workerTask.catch(() => undefined);
    await connection?.disconnect();
    context.audit.add('shutdown', { actor: 'daemon' });
    context.logger.info('application_stopped');
    context.close();
    lock.release();
  }
}

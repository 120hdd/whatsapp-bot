import type { Database as SqliteDatabase } from 'better-sqlite3';

import { DuplicateJobError, NotFoundError } from '../../domain/errors.js';
import {
  assertJobTransition,
  type JobStatus,
  type NewQueueJob,
  type PayloadType,
  type QueueJob,
} from '../../domain/jobs.js';
import type { Database } from '../database.js';
import { insertAudit } from './helpers.js';

interface JobRow {
  id: number;
  uuid: string;
  destination_jid: string;
  payload_type: PayloadType;
  text: string | null;
  media_path: string | null;
  media_hash: string | null;
  media_mime: string | null;
  filename: string | null;
  scheduled_at: string;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error_class: string | null;
  last_error_message: string | null;
  idempotency_key: string;
  options_json: string;
  requested_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  sent_at: string | null;
  remote_message_id: string | null;
  batch_id: string | null;
}

function toJob(row: JobRow): QueueJob {
  return {
    id: row.id,
    uuid: row.uuid,
    destinationJid: row.destination_jid,
    payloadType: row.payload_type,
    text: row.text,
    mediaPath: row.media_path,
    mediaHash: row.media_hash,
    mediaMime: row.media_mime,
    filename: row.filename,
    scheduledAt: row.scheduled_at,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastErrorClass: row.last_error_class,
    lastErrorMessage: row.last_error_message,
    idempotencyKey: row.idempotency_key,
    optionsJson: row.options_json,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    sentAt: row.sent_at,
    remoteMessageId: row.remote_message_id,
    batchId: row.batch_id,
  };
}

function getByReference(db: SqliteDatabase, reference: string): JobRow | undefined {
  return db
    .prepare('SELECT * FROM message_jobs WHERE uuid = ? OR CAST(id AS TEXT) = ? LIMIT 1')
    .get(reference, reference) as JobRow | undefined;
}

export interface QueueCounts {
  [status: string]: number;
}

export class JobRepository {
  public constructor(private readonly database: Database) {}

  public create(job: NewQueueJob, actor = 'cli'): QueueJob {
    const now = new Date().toISOString();
    try {
      return this.database.immediateTransaction(() => {
        const db = this.database.requireConnection();
        db.prepare(
          `INSERT INTO message_jobs(
            uuid, destination_jid, payload_type, text, media_path, media_hash, media_mime,
            filename, scheduled_at, status, max_attempts, idempotency_key, options_json,
            requested_by, batch_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          job.uuid,
          job.destinationJid,
          job.payloadType,
          job.text,
          job.mediaPath,
          job.mediaHash,
          job.mediaMime,
          job.filename,
          job.scheduledAt,
          job.status,
          job.maxAttempts,
          job.idempotencyKey,
          job.optionsJson,
          job.requestedBy,
          job.batchId,
          now,
          now,
        );
        insertAudit(db, job.status === 'SCHEDULED' ? 'job_scheduled' : 'job_enqueued', {
          actor,
          entityType: 'job',
          entityId: job.uuid,
          details: {
            destinationJid: job.destinationJid,
            payloadType: job.payloadType,
            idempotencyKey: job.idempotencyKey,
            batchId: job.batchId,
          },
          now,
        });
        const created = getByReference(db, job.uuid);
        if (!created) throw new Error('Job insert did not return a row');
        return toJob(created);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        const existing = this.findByIdempotencyKey(job.idempotencyKey);
        if (existing) throw new DuplicateJobError(existing.uuid);
      }
      throw error;
    }
  }

  public get(reference: string): QueueJob | null {
    const row = getByReference(this.database.requireConnection(), reference);
    return row ? toJob(row) : null;
  }

  public findByIdempotencyKey(key: string): QueueJob | null {
    const row = this.database
      .requireConnection()
      .prepare(
        `SELECT * FROM message_jobs WHERE idempotency_key = ?
         AND status IN ('PENDING','SCHEDULED','PROCESSING','WAITING_RATE_LIMIT','RETRY','SENT','DRY_RUN')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(key) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  public list(options: { statuses?: readonly JobStatus[]; limit?: number } = {}): QueueJob[] {
    const limit = options.limit ?? 100;
    if (!options.statuses?.length) {
      return (
        this.database
          .requireConnection()
          .prepare('SELECT * FROM message_jobs ORDER BY id DESC LIMIT ?')
          .all(limit) as JobRow[]
      ).map(toJob);
    }
    const placeholders = options.statuses.map(() => '?').join(',');
    return (
      this.database
        .requireConnection()
        .prepare(`SELECT * FROM message_jobs WHERE status IN (${placeholders}) ORDER BY id DESC LIMIT ?`)
        .all(...options.statuses, limit) as JobRow[]
    ).map(toJob);
  }

  public promoteDueScheduled(now: string): number {
    return this.database.immediateTransaction(() =>
      this.database
        .requireConnection()
        .prepare(
          `UPDATE message_jobs SET status = 'PENDING', updated_at = ?
           WHERE status = 'SCHEDULED' AND scheduled_at <= ?`,
        )
        .run(now, now).changes,
    );
  }

  public cancelDisabled(): number {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() =>
      this.database
        .requireConnection()
        .prepare(
          `UPDATE message_jobs
           SET status = 'CANCELLED', updated_at = ?,
             last_error_class = 'DESTINATION_ERROR',
             last_error_message = 'Destination is not allowlisted'
           WHERE status IN ('PENDING','SCHEDULED','RETRY','WAITING_RATE_LIMIT')
             AND EXISTS (
               SELECT 1 FROM destinations d
               WHERE d.jid = message_jobs.destination_jid AND d.enabled = 0
             )`,
        )
        .run(now).changes,
    );
  }

  public claimNext(now: string): QueueJob | null {
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const row = db
        .prepare(
          `SELECT j.* FROM message_jobs j
           JOIN destinations d ON d.jid = j.destination_jid
           WHERE d.enabled = 1 AND d.can_send = 1
             AND (
               j.status = 'PENDING'
               OR (j.status IN ('RETRY','WAITING_RATE_LIMIT')
                 AND j.next_attempt_at IS NOT NULL AND j.next_attempt_at <= ?)
             )
           ORDER BY COALESCE(j.next_attempt_at, j.scheduled_at), j.id
           LIMIT 1`,
        )
        .get(now) as JobRow | undefined;
      if (!row) return null;
      assertJobTransition(row.status, 'PROCESSING');
      const result = db
        .prepare(
          `UPDATE message_jobs
           SET status = 'PROCESSING', attempt_count = attempt_count + 1,
             started_at = ?, updated_at = ?, next_attempt_at = NULL
           WHERE id = ? AND status = ?`,
        )
        .run(now, now, row.id, row.status);
      if (result.changes !== 1) return null;
      const refreshed = getByReference(db, row.uuid);
      return refreshed ? toJob(refreshed) : null;
    });
  }

  public transition(
    reference: string,
    target: JobStatus,
    options: {
      remoteMessageId?: string | null;
      nextAttemptAt?: string | null;
      errorClass?: string | null;
      errorMessage?: string | null;
      actor?: string;
      auditEvent?: string;
    } = {},
  ): QueueJob {
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const row = getByReference(db, reference);
      if (!row) throw new NotFoundError(`Unknown job: ${reference}`);
      assertJobTransition(row.status, target);
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE message_jobs SET
          status = ?, remote_message_id = COALESCE(?, remote_message_id),
          next_attempt_at = ?, last_error_class = ?, last_error_message = ?,
          updated_at = ?, sent_at = CASE WHEN ? = 'SENT' THEN ? ELSE sent_at END
         WHERE id = ?`,
      ).run(
        target,
        options.remoteMessageId ?? null,
        options.nextAttemptAt ?? null,
        options.errorClass ?? null,
        options.errorMessage ?? null,
        now,
        target,
        now,
        row.id,
      );
      if (options.auditEvent) {
        insertAudit(db, options.auditEvent, {
          actor: options.actor ?? 'system',
          entityType: 'job',
          entityId: row.uuid,
          details: { from: row.status, to: target },
          now,
        });
      }
      const refreshed = getByReference(db, row.uuid);
      if (!refreshed) throw new Error('Job disappeared after transition');
      return toJob(refreshed);
    });
  }

  public recoverStaleProcessing(): number {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const jobs = db
        .prepare(`SELECT uuid FROM message_jobs WHERE status = 'PROCESSING'`)
        .all() as { uuid: string }[];
      const result = db
        .prepare(
          `UPDATE message_jobs SET
            status = 'REVIEW_REQUIRED', updated_at = ?,
            last_error_class = 'DELIVERY_UNCERTAIN_AFTER_RESTART',
            last_error_message = 'Process stopped during delivery; review before retrying'
           WHERE status = 'PROCESSING'`,
        )
        .run(now);
      for (const job of jobs) {
        insertAudit(db, 'job_review_required', {
          actor: 'startup',
          entityType: 'job',
          entityId: job.uuid,
          details: { reason: 'delivery_uncertain_after_restart' },
          now,
        });
      }
      return result.changes;
    });
  }

  public cancel(reference: string, actor = 'cli'): QueueJob {
    const job = this.get(reference);
    if (!job) throw new NotFoundError(`Unknown job: ${reference}`);
    return this.transition(reference, 'CANCELLED', {
      actor,
      auditEvent: 'job_cancelled',
      errorClass: 'OPERATOR_CANCELLED',
      errorMessage: 'Cancelled by operator',
    });
  }

  public retry(reference: string, actor = 'cli'): QueueJob {
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const row = getByReference(db, reference);
      if (!row) throw new NotFoundError(`Unknown job: ${reference}`);
      assertJobTransition(row.status, 'RETRY');
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE message_jobs SET
          status = 'RETRY', attempt_count = 0, next_attempt_at = ?,
          last_error_class = NULL, last_error_message = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now, now, row.id);
      insertAudit(db, 'job_manually_retried', {
        actor,
        entityType: 'job',
        entityId: row.uuid,
        details: { from: row.status, to: 'RETRY' },
        now,
      });
      const refreshed = getByReference(db, row.uuid);
      if (!refreshed) throw new Error('Job disappeared after retry');
      return toJob(refreshed);
    });
  }

  public markSent(reference: string, actor = 'cli'): QueueJob {
    return this.transition(reference, 'SENT', {
      actor,
      auditEvent: 'job_manually_marked_sent',
      remoteMessageId: 'operator-confirmed',
    });
  }

  public counts(): QueueCounts {
    const rows = this.database
      .requireConnection()
      .prepare('SELECT status, COUNT(*) AS count FROM message_jobs GROUP BY status')
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  public oldestPending(): string | null {
    const row = this.database
      .requireConnection()
      .prepare(
        `SELECT MIN(created_at) AS oldest FROM message_jobs
         WHERE status IN ('PENDING','SCHEDULED','RETRY','WAITING_RATE_LIMIT')`,
      )
      .get() as { oldest: string | null };
    return row.oldest;
  }

  public lastSuccessfulSend(): string | null {
    const row = this.database
      .requireConnection()
      .prepare(`SELECT MAX(sent_at) AS latest FROM message_jobs WHERE status = 'SENT'`)
      .get() as { latest: string | null };
    return row.latest;
  }
}

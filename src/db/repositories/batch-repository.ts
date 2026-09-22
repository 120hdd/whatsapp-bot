import type { BatchStatus, BatchType, MessageBatch } from '../../domain/batches.js';
import type { JobStatus } from '../../domain/jobs.js';
import type { Database } from '../database.js';
import { insertAudit } from './helpers.js';

interface BatchRow {
  id: string;
  type: BatchType;
  target_count: number;
  created_at: string;
}

function toBatch(row: BatchRow): MessageBatch {
  return { id: row.id, type: row.type, targetCount: row.target_count, createdAt: row.created_at };
}

export class BatchRepository {
  public constructor(private readonly database: Database) {}

  public create(id: string, type: BatchType, targetCount: number, actor = 'self-controller'): MessageBatch {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      db.prepare('INSERT INTO message_batches(id, type, target_count, created_at) VALUES (?, ?, ?, ?)')
        .run(id, type, targetCount, now);
      insertAudit(db, 'message_batch_created', {
        actor,
        entityType: 'message_batch',
        entityId: id,
        details: { type, targetCount },
        now,
      });
      return { id, type, targetCount, createdAt: now };
    });
  }

  public get(id: string): BatchStatus | null {
    const db = this.database.requireConnection();
    const row = db.prepare('SELECT * FROM message_batches WHERE id = ?').get(id) as BatchRow | undefined;
    if (!row) return null;
    const statusRows = db
      .prepare('SELECT status, COUNT(*) AS count FROM message_jobs WHERE batch_id = ? GROUP BY status')
      .all(id) as { status: JobStatus; count: number }[];
    return {
      ...toBatch(row),
      counts: Object.fromEntries(statusRows.map((status) => [status.status, status.count])),
    };
  }
}

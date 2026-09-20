import type { DiscoveredDestination, Destination } from '../../domain/groups.js';
import { NotFoundError } from '../../domain/errors.js';
import type { Database } from '../database.js';
import { insertAudit } from './helpers.js';

interface DestinationRow {
  jid: string;
  subject: string;
  description: string | null;
  owner_jid: string | null;
  participant_count: number | null;
  addressing_mode: string | null;
  alias: string | null;
  enabled: number;
  can_send: number;
  created_at: string;
  updated_at: string;
  last_refreshed_at: string;
}

function toDestination(row: DestinationRow): Destination {
  return {
    jid: row.jid,
    subject: row.subject,
    description: row.description,
    ownerJid: row.owner_jid,
    participantCount: row.participant_count,
    addressingMode: row.addressing_mode,
    alias: row.alias,
    enabled: row.enabled === 1,
    canSend: row.can_send === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

export class DestinationRepository {
  public constructor(private readonly database: Database) {}

  public synchronize(items: readonly DiscoveredDestination[], actor = 'daemon'): number {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const statement = db.prepare(
        `INSERT INTO destinations(
          jid, subject, description, owner_jid, participant_count, addressing_mode,
          can_send, created_at, updated_at, last_refreshed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          subject = excluded.subject,
          description = excluded.description,
          owner_jid = excluded.owner_jid,
          participant_count = excluded.participant_count,
          addressing_mode = excluded.addressing_mode,
          can_send = excluded.can_send,
          updated_at = excluded.updated_at,
          last_refreshed_at = excluded.last_refreshed_at`,
      );
      for (const item of items) {
        statement.run(
          item.jid,
          item.subject,
          item.description ?? null,
          item.ownerJid ?? null,
          item.participantCount ?? null,
          item.addressingMode ?? null,
          item.canSend === false ? 0 : 1,
          now,
          now,
          now,
        );
      }
      insertAudit(db, 'group_refresh', {
        actor,
        entityType: 'destination',
        details: { discovered: items.length },
        now,
      });
      return items.length;
    });
  }

  public resolve(reference: string): Destination | null {
    const row = this.database
      .requireConnection()
      .prepare('SELECT * FROM destinations WHERE jid = ? OR alias = ? COLLATE NOCASE LIMIT 1')
      .get(reference, reference) as DestinationRow | undefined;
    return row ? toDestination(row) : null;
  }

  public list(enabledOnly = false): Destination[] {
    const rows = this.database
      .requireConnection()
      .prepare(
        `SELECT * FROM destinations ${enabledOnly ? 'WHERE enabled = 1' : ''}
         ORDER BY subject COLLATE NOCASE, jid`,
      )
      .all() as DestinationRow[];
    return rows.map(toDestination);
  }

  public setEnabled(reference: string, enabled: boolean, actor = 'cli'): Destination {
    const destination = this.resolve(reference);
    if (!destination) throw new NotFoundError(`Unknown destination: ${reference}`);
    const now = new Date().toISOString();
    this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      db.prepare('UPDATE destinations SET enabled = ?, updated_at = ? WHERE jid = ?').run(
        enabled ? 1 : 0,
        now,
        destination.jid,
      );
      let cancelled = 0;
      if (!enabled) {
        const result = db.prepare(
          `UPDATE message_jobs
           SET status = 'CANCELLED', updated_at = ?,
             last_error_class = 'DESTINATION_ERROR',
             last_error_message = 'Destination was removed from the allowlist'
           WHERE destination_jid = ?
             AND status IN ('PENDING','SCHEDULED','RETRY','WAITING_RATE_LIMIT')`,
        ).run(now, destination.jid);
        cancelled = result.changes;
      }
      insertAudit(db, enabled ? 'group_allowed' : 'group_denied', {
        actor,
        entityType: 'destination',
        entityId: destination.jid,
        details: { cancelledJobs: cancelled },
        now,
      });
    });
    const updated = this.resolve(destination.jid);
    if (!updated) throw new Error('Destination disappeared after update');
    return updated;
  }

  public setAlias(reference: string, alias: string | null, actor = 'cli'): Destination {
    const destination = this.resolve(reference);
    if (!destination) throw new NotFoundError(`Unknown destination: ${reference}`);
    const normalized = alias?.trim() || null;
    if (normalized && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalized)) {
      throw new Error('Alias must contain only letters, numbers, dot, underscore, or hyphen');
    }
    const now = new Date().toISOString();
    this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      db.prepare('UPDATE destinations SET alias = ?, updated_at = ? WHERE jid = ?').run(
        normalized,
        now,
        destination.jid,
      );
      insertAudit(db, normalized ? 'group_alias_set' : 'group_alias_removed', {
        actor,
        entityType: 'destination',
        entityId: destination.jid,
        ...(normalized ? { details: { alias: normalized } } : {}),
        now,
      });
    });
    const updated = this.resolve(destination.jid);
    if (!updated) throw new Error('Destination disappeared after alias update');
    return updated;
  }

  public setCanSend(jid: string, canSend: boolean): void {
    this.database
      .requireConnection()
      .prepare('UPDATE destinations SET can_send = ?, updated_at = ? WHERE jid = ?')
      .run(canSend ? 1 : 0, new Date().toISOString(), jid);
  }
}

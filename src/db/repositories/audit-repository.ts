import type { Database } from '../database.js';
import { insertAudit } from './helpers.js';

export interface AuditEvent {
  id: number;
  eventType: string;
  actor: string;
  entityType: string | null;
  entityId: string | null;
  details: Readonly<Record<string, unknown>> | null;
  createdAt: string;
}

interface AuditRow {
  id: number;
  event_type: string;
  actor: string;
  entity_type: string | null;
  entity_id: string | null;
  details_json: string | null;
  created_at: string;
}

export class AuditRepository {
  public constructor(private readonly database: Database) {}

  public add(
    eventType: string,
    options: {
      actor?: string;
      entityType?: string;
      entityId?: string;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ): void {
    this.database.immediateTransaction(() => {
      insertAudit(this.database.requireConnection(), eventType, options);
    });
  }

  public list(limit = 100): AuditEvent[] {
    const rows = this.database
      .requireConnection()
      .prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?')
      .all(limit) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      actor: row.actor,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details_json
        ? (JSON.parse(row.details_json) as Readonly<Record<string, unknown>>)
        : null,
      createdAt: row.created_at,
    }));
  }
}

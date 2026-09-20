import type { Database as SqliteDatabase } from 'better-sqlite3';

export function insertAudit(
  db: SqliteDatabase,
  eventType: string,
  options: {
    actor?: string;
    entityType?: string;
    entityId?: string;
    details?: Readonly<Record<string, unknown>>;
    now?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO audit_events(
      event_type, actor, entity_type, entity_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    eventType,
    options.actor ?? 'system',
    options.entityType ?? null,
    options.entityId ?? null,
    options.details ? JSON.stringify(options.details) : null,
    options.now ?? new Date().toISOString(),
  );
}

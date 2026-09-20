export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE destinations (
        jid TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        description TEXT,
        owner_jid TEXT,
        participant_count INTEGER,
        addressing_mode TEXT,
        alias TEXT UNIQUE COLLATE NOCASE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        can_send INTEGER NOT NULL DEFAULT 1 CHECK (can_send IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_refreshed_at TEXT NOT NULL
      );

      CREATE TABLE media_assets (
        hash TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        mime_type TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE message_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        destination_jid TEXT NOT NULL REFERENCES destinations(jid),
        payload_type TEXT NOT NULL CHECK (payload_type IN ('text','image','video','document','audio')),
        text TEXT,
        media_path TEXT,
        media_hash TEXT REFERENCES media_assets(hash),
        media_mime TEXT,
        filename TEXT,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'PENDING','SCHEDULED','PROCESSING','WAITING_RATE_LIMIT','RETRY',
          'SENT','FAILED','CANCELLED','REVIEW_REQUIRED','DRY_RUN'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        next_attempt_at TEXT,
        last_error_class TEXT,
        last_error_message TEXT,
        idempotency_key TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '{}',
        requested_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        sent_at TEXT,
        remote_message_id TEXT
      );

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE wa_auth_creds (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE wa_auth_keys (
        category TEXT NOT NULL,
        key_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (category, key_id)
      );

      CREATE TABLE controller_messages (
        message_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        command_hash TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'queue_indexes',
    sql: `
      CREATE INDEX ix_jobs_status_due
        ON message_jobs(status, next_attempt_at, scheduled_at);
      CREATE INDEX ix_jobs_destination
        ON message_jobs(destination_jid);
      CREATE INDEX ix_audit_created
        ON audit_events(created_at);
      CREATE UNIQUE INDEX uq_jobs_active_idempotency
        ON message_jobs(idempotency_key)
        WHERE status IN (
          'PENDING','SCHEDULED','PROCESSING','WAITING_RATE_LIMIT','RETRY','SENT','DRY_RUN'
        );
    `,
  },
] as const;

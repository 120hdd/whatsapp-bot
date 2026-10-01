import type { Database } from '../database.js';

export interface ForwardSource {
  sourceKey: string;
  payload: Buffer;
  contentType: string;
  receivedAt: string;
  expiresAt: string | null;
}

export class ForwardSourceRepository {
  public constructor(private readonly database: Database) {}

  public save(source: ForwardSource): void {
    this.database.requireConnection().prepare(`
      INSERT INTO forward_sources(source_key, payload, content_type, received_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO NOTHING
    `).run(source.sourceKey, source.payload, source.contentType, source.receivedAt, source.expiresAt);
  }

  public get(sourceKey: string): ForwardSource | null {
    const row = this.database.requireConnection().prepare(
      'SELECT * FROM forward_sources WHERE source_key = ?',
    ).get(sourceKey) as {
      source_key: string; payload: Buffer; content_type: string;
      received_at: string; expires_at: string | null;
    } | undefined;
    return row ? {
      sourceKey: row.source_key,
      payload: row.payload,
      contentType: row.content_type,
      receivedAt: row.received_at,
      expiresAt: row.expires_at,
    } : null;
  }
}

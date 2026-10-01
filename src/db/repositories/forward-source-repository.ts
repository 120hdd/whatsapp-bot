import type { Database } from '../database.js';

export interface ForwardSource {
  sourceKey: string;
  payload: Buffer;
  contentType: string;
  receivedAt: string;
  expiresAt: string | null;
}

export type ForwardSourceSummary = Omit<ForwardSource, 'payload'> & { messageId: string };

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

  public list(limit = 20): ForwardSourceSummary[] {
    const rows = this.database.requireConnection().prepare(`
      SELECT source_key, content_type, received_at, expires_at
      FROM forward_sources ORDER BY received_at DESC, source_key DESC LIMIT ?
    `).all(limit) as Array<{
      source_key: string; content_type: string; received_at: string; expires_at: string | null;
    }>;
    return rows.map((row) => ({
      sourceKey: row.source_key,
      messageId: row.source_key.slice(row.source_key.indexOf('|') + 1),
      contentType: row.content_type,
      receivedAt: row.received_at,
      expiresAt: row.expires_at,
    }));
  }

  public resolve(reference: string): ForwardSource | null {
    if (reference.includes('|')) return this.get(reference);
    const rows = this.database.requireConnection().prepare(`
      SELECT source_key FROM forward_sources
      WHERE substr(source_key, instr(source_key, '|') + 1) = ? LIMIT 2
    `).all(reference) as Array<{ source_key: string }>;
    if (rows.length > 1) {
      throw new Error('Source message ID is ambiguous; use the full source key from forwardsources');
    }
    return rows[0] ? this.get(rows[0].source_key) : null;
  }
}

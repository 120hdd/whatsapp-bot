import type { Database } from '../database.js';

export interface MediaAsset {
  hash: string;
  path: string;
  byteSize: number;
  mimeType: string | null;
  createdAt: string;
}

interface MediaRow {
  hash: string;
  path: string;
  byte_size: number;
  mime_type: string | null;
  created_at: string;
}

function mapRow(row: MediaRow): MediaAsset {
  return {
    hash: row.hash,
    path: row.path,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
    createdAt: row.created_at,
  };
}

export class MediaRepository {
  public constructor(private readonly database: Database) {}

  public get(hash: string): MediaAsset | null {
    const row = this.database
      .requireConnection()
      .prepare('SELECT * FROM media_assets WHERE hash = ?')
      .get(hash) as MediaRow | undefined;
    return row ? mapRow(row) : null;
  }

  public upsert(asset: Omit<MediaAsset, 'createdAt'>): MediaAsset {
    const now = new Date().toISOString();
    this.database.requireConnection().prepare(
      `INSERT INTO media_assets(hash, path, byte_size, mime_type, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
         path = excluded.path, byte_size = excluded.byte_size,
         mime_type = excluded.mime_type`,
    ).run(asset.hash, asset.path, asset.byteSize, asset.mimeType, now);
    const saved = this.get(asset.hash);
    if (!saved) throw new Error('Media asset disappeared after upsert');
    return saved;
  }

  public removeIfUnreferenced(hash: string): boolean {
    const result = this.database.requireConnection().prepare(
      `DELETE FROM media_assets
       WHERE hash = ? AND NOT EXISTS (
         SELECT 1 FROM message_jobs WHERE media_hash = media_assets.hash
       )`,
    ).run(hash);
    return result.changes === 1;
  }
}

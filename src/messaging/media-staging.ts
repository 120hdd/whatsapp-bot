import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { PayloadType } from '../domain/jobs.js';

export interface StagedMedia {
  path: string;
  hash: string;
  byteSize: number;
  mimeType: string;
  payloadType: Exclude<PayloadType, 'text'>;
  created: boolean;
  safeFilename: string;
}

const mimeByExtension: Readonly<Record<string, { mime: string; type: Exclude<PayloadType, 'text'> }>> = {
  '.jpg': { mime: 'image/jpeg', type: 'image' },
  '.jpeg': { mime: 'image/jpeg', type: 'image' },
  '.png': { mime: 'image/png', type: 'image' },
  '.webp': { mime: 'image/webp', type: 'image' },
  '.gif': { mime: 'image/gif', type: 'video' },
  '.mp4': { mime: 'video/mp4', type: 'video' },
  '.mov': { mime: 'video/quicktime', type: 'video' },
  '.mkv': { mime: 'video/x-matroska', type: 'video' },
  '.mp3': { mime: 'audio/mpeg', type: 'audio' },
  '.ogg': { mime: 'audio/ogg', type: 'audio' },
  '.opus': { mime: 'audio/ogg; codecs=opus', type: 'audio' },
  '.wav': { mime: 'audio/wav', type: 'audio' },
  '.pdf': { mime: 'application/pdf', type: 'document' },
  '.txt': { mime: 'text/plain', type: 'document' },
  '.zip': { mime: 'application/zip', type: 'document' },
};

export function sanitizeFilename(value: string): string {
  const cleaned = basename(value)
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'attachment.bin';
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class MediaStager {
  public constructor(
    private readonly mediaDir: string,
    private readonly maxBytes: number,
  ) {}

  public async stage(sourcePath: string, requestedFilename?: string): Promise<StagedMedia> {
    const source = resolve(sourcePath);
    const stats = statSync(source);
    if (!stats.isFile()) throw new Error('Media path must be a regular file');
    if (stats.size > this.maxBytes) {
      throw new Error(`Media exceeds configured maximum of ${this.maxBytes} bytes`);
    }
    const safeFilename = sanitizeFilename(requestedFilename ?? basename(source));
    const extension = extname(safeFilename).toLowerCase();
    const detected = mimeByExtension[extension] ?? {
      mime: 'application/octet-stream',
      type: 'document' as const,
    };
    const hash = await hashFile(source);
    const shard = hash.slice(0, 2);
    const targetDir = join(this.mediaDir, shard);
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const target = join(targetDir, `${hash}${extension || '.bin'}`);
    if (existsSync(target)) {
      return {
        path: target,
        hash,
        byteSize: stats.size,
        mimeType: detected.mime,
        payloadType: detected.type,
        created: false,
        safeFilename,
      };
    }
    const temporary = join(targetDir, `.${hash}.${randomUUID()}.tmp`);
    try {
      await pipeline(
        createReadStream(source, { flags: 'r' }),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      const handle = openSync(temporary, 'r+');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporary, target);
      try {
        const directoryHandle = openSync(targetDir, 'r');
        try {
          fsyncSync(directoryHandle);
        } finally {
          closeSync(directoryHandle);
        }
      } catch {
        // Directory fsync is unsupported on Windows; the file itself was flushed above.
      }
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(target)) throw error;
    }
    return {
      path: target,
      hash,
      byteSize: stats.size,
      mimeType: detected.mime,
      payloadType: detected.type,
      created: true,
      safeFilename,
    };
  }
}

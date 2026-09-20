import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';

import type { AppConfig } from '../config/schema.js';
import { DuplicateJobError, NotFoundError } from '../domain/errors.js';
import type { PayloadType, QueueJob } from '../domain/jobs.js';
import {
  DestinationRepository,
  JobRepository,
  MediaRepository,
} from '../db/repositories/index.js';
import { buildIdempotencyKey, normalizeMessage } from './idempotency.js';
import { MediaStager, type StagedMedia } from './media-staging.js';

export interface QueueMessageRequest {
  destination: string;
  text?: string;
  mediaPath?: string;
  filename?: string;
  scheduledAt?: Date;
  force?: boolean;
  actor?: string;
  options?: Readonly<Record<string, unknown>>;
}

export interface QueueMessageResult {
  job: QueueJob;
  duplicate: boolean;
}

export class MessageService {
  private readonly stager: MediaStager;

  public constructor(
    private readonly destinations: DestinationRepository,
    private readonly jobs: JobRepository,
    private readonly media: MediaRepository,
    private readonly config: AppConfig,
  ) {
    this.stager = new MediaStager(config.mediaDir, config.maxMediaBytes);
  }

  public async enqueue(request: QueueMessageRequest): Promise<QueueMessageResult> {
    const destination = this.destinations.resolve(request.destination);
    if (!destination) {
      throw new NotFoundError(`Unknown destination: ${request.destination}. Refresh groups first.`);
    }
    if (!destination.enabled) throw new Error(`Destination "${destination.subject}" is not allowlisted`);
    if (!destination.canSend) throw new Error(`Destination "${destination.subject}" is not sendable`);
    const text = normalizeMessage(request.text);
    Buffer.from(text, 'utf8');
    let staged: StagedMedia | null = null;
    if (request.mediaPath) staged = await this.stager.stage(request.mediaPath, request.filename);
    if (!text && !staged) throw new Error('A message must contain text or a media file');
    const textLimit = staged ? 1024 : 65_536;
    if (text.length > textLimit) {
      throw new Error(`${staged ? 'Media caption' : 'Message'} exceeds ${textLimit} characters`);
    }
    const now = new Date();
    if (request.scheduledAt && request.scheduledAt.valueOf() <= now.valueOf()) {
      throw new Error('Scheduled delivery must be in the future');
    }
    const uuid = randomUUID();
    const scheduleIdentity = request.scheduledAt?.toISOString() ?? 'IMMEDIATE';
    const options = request.options ?? {};
    const payloadType: PayloadType = staged?.payloadType ?? 'text';
    const idempotencyKey = buildIdempotencyKey({
      destinationJid: destination.jid,
      payloadType,
      text,
      mediaHash: staged?.hash ?? null,
      scheduleIdentity,
      filename: request.filename ? (staged?.safeFilename ?? null) : null,
      options,
      ...(request.force ? { forceNonce: uuid } : {}),
    });

    if (staged) {
      this.media.upsert({
        hash: staged.hash,
        path: staged.path,
        byteSize: staged.byteSize,
        mimeType: staged.mimeType,
      });
    }
    try {
      const job = this.jobs.create(
        {
          uuid,
          destinationJid: destination.jid,
          payloadType,
          text: text || null,
          mediaPath: staged?.path ?? null,
          mediaHash: staged?.hash ?? null,
          mediaMime: staged?.mimeType ?? null,
          filename: staged?.safeFilename ?? null,
          scheduledAt: request.scheduledAt?.toISOString() ?? now.toISOString(),
          status: request.scheduledAt ? 'SCHEDULED' : 'PENDING',
          maxAttempts: this.config.maxAttempts,
          idempotencyKey,
          optionsJson: JSON.stringify(options),
          requestedBy: request.actor ?? 'cli',
        },
        request.actor ?? 'cli',
      );
      return { job, duplicate: false };
    } catch (error) {
      if (error instanceof DuplicateJobError) {
        const existing = this.jobs.get(error.existingId);
        if (!existing) throw error;
        return { job: existing, duplicate: true };
      }
      if (staged?.created && this.media.removeIfUnreferenced(staged.hash) && existsSync(staged.path)) {
        rmSync(staged.path, { force: true });
      }
      throw error;
    }
  }
}

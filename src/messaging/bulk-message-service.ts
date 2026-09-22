import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { BatchType } from '../domain/batches.js';
import type { Destination } from '../domain/groups.js';
import type { BatchRepository } from '../db/repositories/index.js';
import type { MessageService } from './message-service.js';

export interface BulkEnqueueRequest {
  type: BatchType;
  destinations: readonly Destination[];
  text: string;
  actor?: string;
  requestedCount?: number;
  duplicateTargets?: number;
  skipped?: number;
}

export interface BulkEnqueueResult {
  batchId: string;
  targets: number;
  queued: number;
  duplicateJobs: number;
  duplicateTargets: number;
  failed: number;
}

export class BulkMessageService {
  public constructor(
    private readonly messages: MessageService,
    private readonly batches: BatchRepository,
    private readonly logger: Logger,
  ) {}

  public async enqueue(request: BulkEnqueueRequest): Promise<BulkEnqueueResult> {
    const unique = new Map(request.destinations.map((destination) => [destination.jid, destination]));
    const destinations = [...unique.values()];
    const batchId = randomUUID();
    this.batches.create(batchId, request.type, destinations.length, request.actor ?? 'self-controller');
    let queued = 0;
    let duplicateJobs = 0;
    let failed = 0;
    for (const destination of destinations) {
      try {
        const result = await this.messages.enqueue({
          destination: destination.jid,
          text: request.text,
          actor: request.actor ?? 'self-controller',
          batchId,
        });
        if (result.duplicate) duplicateJobs += 1;
        else queued += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          { err: error, command_type: request.type, batch_id: batchId, destination_jid: destination.jid },
          'bulk_enqueue_destination_failed',
        );
      }
    }
    const result = {
      batchId,
      targets: destinations.length,
      queued,
      duplicateJobs,
      duplicateTargets:
        (request.duplicateTargets ?? 0) + request.destinations.length - destinations.length,
      failed,
    };
    this.logger.info(
      {
        command_type: request.type,
        batch_id: batchId,
        requested_targets: request.requestedCount ?? request.destinations.length,
        resolved_targets: destinations.length,
        queued_count: queued,
        duplicate_count: duplicateJobs + result.duplicateTargets,
        skipped_count: request.skipped ?? 0,
        failure_count: failed,
      },
      'bulk_enqueue_completed',
    );
    return result;
  }
}

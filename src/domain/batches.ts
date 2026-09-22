import type { JobStatus } from './jobs.js';

export const BATCH_TYPES = ['sendall', 'sendmulti', 'sendset'] as const;
export type BatchType = (typeof BATCH_TYPES)[number];

export interface MessageBatch {
  id: string;
  type: BatchType;
  targetCount: number;
  createdAt: string;
}

export interface BatchStatus extends MessageBatch {
  counts: Partial<Record<JobStatus, number>>;
}

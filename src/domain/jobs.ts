export const JOB_STATUSES = [
  'PENDING',
  'SCHEDULED',
  'PROCESSING',
  'WAITING_RATE_LIMIT',
  'RETRY',
  'SENT',
  'FAILED',
  'CANCELLED',
  'REVIEW_REQUIRED',
  'DRY_RUN',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const PAYLOAD_TYPES = ['text', 'image', 'video', 'document', 'audio'] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

const transitions: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  PENDING: new Set(['PROCESSING', 'CANCELLED']),
  SCHEDULED: new Set(['PENDING', 'CANCELLED']),
  PROCESSING: new Set([
    'SENT',
    'DRY_RUN',
    'RETRY',
    'WAITING_RATE_LIMIT',
    'FAILED',
    'REVIEW_REQUIRED',
  ]),
  WAITING_RATE_LIMIT: new Set(['PROCESSING', 'CANCELLED']),
  RETRY: new Set(['PROCESSING', 'CANCELLED']),
  FAILED: new Set(['RETRY', 'CANCELLED']),
  REVIEW_REQUIRED: new Set(['RETRY', 'SENT', 'FAILED', 'CANCELLED']),
  SENT: new Set(),
  CANCELLED: new Set(),
  DRY_RUN: new Set(),
};

export class InvalidStateTransitionError extends Error {
  public constructor(current: JobStatus, target: JobStatus) {
    super(`Illegal job transition: ${current} -> ${target}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export function assertJobTransition(current: JobStatus, target: JobStatus): void {
  if (!transitions[current].has(target)) {
    throw new InvalidStateTransitionError(current, target);
  }
}

export interface QueueJob {
  id: number;
  uuid: string;
  destinationJid: string;
  payloadType: PayloadType;
  text: string | null;
  mediaPath: string | null;
  mediaHash: string | null;
  mediaMime: string | null;
  filename: string | null;
  scheduledAt: string;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastErrorClass: string | null;
  lastErrorMessage: string | null;
  idempotencyKey: string;
  optionsJson: string;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  sentAt: string | null;
  remoteMessageId: string | null;
  batchId: string | null;
}

export interface NewQueueJob {
  uuid: string;
  destinationJid: string;
  payloadType: PayloadType;
  text: string | null;
  mediaPath: string | null;
  mediaHash: string | null;
  mediaMime: string | null;
  filename: string | null;
  scheduledAt: string;
  status: Extract<JobStatus, 'PENDING' | 'SCHEDULED'>;
  maxAttempts: number;
  idempotencyKey: string;
  optionsJson: string;
  requestedBy: string;
  batchId: string | null;
}

export interface SendableJob extends QueueJob {
  status: 'PROCESSING';
}

export function asSendableJob(job: QueueJob): SendableJob {
  if (job.status !== 'PROCESSING') {
    throw new InvalidStateTransitionError(job.status, 'PROCESSING');
  }
  return job as SendableJob;
}

export const UNSENT_STATUSES: readonly JobStatus[] = [
  'PENDING',
  'SCHEDULED',
  'RETRY',
  'WAITING_RATE_LIMIT',
];

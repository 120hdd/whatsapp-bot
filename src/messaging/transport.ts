import type { SendableJob } from '../domain/jobs.js';

export interface SendResult {
  remoteMessageId: string | null;
  dryRun: boolean;
}

export interface MessageTransport {
  readonly name: string;
  send(job: SendableJob): Promise<SendResult>;
}

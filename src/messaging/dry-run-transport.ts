import type { SendableJob } from '../domain/jobs.js';
import type { MessageTransport, SendResult } from './transport.js';

export class DryRunTransport implements MessageTransport {
  public readonly name = 'dry-run';
  public readonly sendCalls: string[] = [];

  public async send(job: SendableJob): Promise<SendResult> {
    this.sendCalls.push(job.uuid);
    return Promise.resolve({ remoteMessageId: `dryrun:${job.uuid}`, dryRun: true });
  }
}

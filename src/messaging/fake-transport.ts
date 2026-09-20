import { DeliveryError } from '../domain/errors.js';
import type { SendableJob } from '../domain/jobs.js';
import type { MessageTransport, SendResult } from './transport.js';

export type FakeOutcome = SendResult | DeliveryError | ((job: SendableJob) => SendResult);

export class FakeTransport implements MessageTransport {
  public readonly name = 'fake';
  public readonly sendCalls: SendableJob[] = [];

  public constructor(private readonly outcomes: FakeOutcome[] = []) {}

  public async send(job: SendableJob): Promise<SendResult> {
    this.sendCalls.push(job);
    const outcome = this.outcomes.shift() ?? {
      remoteMessageId: `fake:${job.uuid}`,
      dryRun: false,
    };
    if (outcome instanceof DeliveryError) throw outcome;
    return Promise.resolve(typeof outcome === 'function' ? outcome(job) : outcome);
  }
}

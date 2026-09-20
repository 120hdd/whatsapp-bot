import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import type { SendableJob } from '../src/domain/jobs.js';
import { FakeTransport } from '../src/messaging/fake-transport.js';
import { QueueWorker } from '../src/messaging/queue-worker.js';
import type { MessageTransport, SendResult } from '../src/messaging/transport.js';
import { addAllowedGroup, makeTestContext, type TestContext } from './helpers/context.js';

class BlockingTransport implements MessageTransport {
  public readonly name = 'blocking-test';
  public started = false;
  private releaseDelivery: (() => void) | null = null;

  public async send(job: SendableJob): Promise<SendResult> {
    this.started = true;
    await new Promise<void>((resolve) => {
      this.releaseDelivery = resolve;
    });
    return { remoteMessageId: `blocking:${job.uuid}`, dryRun: false };
  }

  public release(): void {
    this.releaseDelivery?.();
  }
}

function makeWorker(test: TestContext, transport: MessageTransport) {
  return new QueueWorker(
    test.context.jobs,
    test.context.destinations,
    test.context.state,
    test.context.audit,
    transport,
    test.context.config,
    test.context.logger,
  );
}

describe('worker shutdown', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('stops cleanly while idle', async () => {
    test = makeTestContext();
    const queueWorker = makeWorker(test, new FakeTransport());
    const running = queueWorker.run();
    await sleep(20);
    queueWorker.requestStop();
    await running;
    expect(test.context.state.get('worker_state')).toBe('STOPPED');
  });

  it('settles an active transport result before stopping', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const created = await test.context.messages.enqueue({ destination: 'work', text: 'active' });
    const transport = new BlockingTransport();
    const queueWorker = makeWorker(test, transport);
    const running = queueWorker.run();
    while (!transport.started) await sleep(5);
    queueWorker.requestStop();
    transport.release();
    await running;
    expect(test.context.jobs.get(created.job.uuid)?.status).toBe('SENT');
  });
});

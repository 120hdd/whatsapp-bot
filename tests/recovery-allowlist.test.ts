import { afterEach, describe, expect, it } from 'vitest';

import { FakeTransport } from '../src/messaging/fake-transport.js';
import { QueueWorker } from '../src/messaging/queue-worker.js';
import { addAllowedGroup, makeTestContext, type TestContext } from './helpers/context.js';

describe('crash recovery and allowlist invariants', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('moves PROCESSING to REVIEW_REQUIRED and does not automatically claim it', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const created = await test.context.messages.enqueue({ destination: 'work', text: 'uncertain' });
    test.context.jobs.claimNext(new Date().toISOString());
    expect(test.context.jobs.recoverStaleProcessing()).toBe(1);
    expect(test.context.jobs.get(created.job.uuid)?.status).toBe('REVIEW_REQUIRED');
    const fake = new FakeTransport();
    const queueWorker = new QueueWorker(
      test.context.jobs,
      test.context.destinations,
      test.context.state,
      test.context.audit,
      fake,
      test.context.config,
      test.context.logger,
    );
    expect(await queueWorker.processOnce()).toBe(false);
    expect(fake.sendCalls).toHaveLength(0);
    expect(test.context.jobs.markSent(created.job.uuid).status).toBe('SENT');
  });

  it('defaults newly discovered groups to disabled', () => {
    test = makeTestContext();
    test.context.destinations.synchronize([
      { jid: '120363000000000000@g.us', subject: 'New group' },
    ]);
    expect(test.context.destinations.resolve('120363000000000000@g.us')?.enabled).toBe(false);
  });

  it('preserves immutable identity, aliases, and allowlisting across a rename', () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { subject: 'Old name', alias: 'stable' });
    test.context.destinations.synchronize([
      { jid: '120363000000000000@g.us', subject: 'Renamed group', participantCount: 10 },
    ]);
    const destination = test.context.destinations.resolve('stable');
    expect(destination?.jid).toBe('120363000000000000@g.us');
    expect(destination?.subject).toBe('Renamed group');
    expect(destination?.enabled).toBe(true);
  });

  it('refuses disabled destinations in MessageService', async () => {
    test = makeTestContext();
    test.context.destinations.synchronize([
      { jid: '120363000000000000@g.us', subject: 'Disabled' },
    ]);
    await expect(
      test.context.messages.enqueue({
        destination: '120363000000000000@g.us',
        text: 'blocked',
      }),
    ).rejects.toThrow('not allowlisted');
  });
});

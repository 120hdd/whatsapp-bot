import { afterEach, describe, expect, it } from 'vitest';

import { InvalidStateTransitionError } from '../src/domain/jobs.js';
import { makeTestContext, addAllowedGroup, type TestContext } from './helpers/context.js';

describe('durable queue repository', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('enqueues, claims atomically, increments attempts, and sends', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const result = await test.context.messages.enqueue({ destination: 'work', text: 'hello' });
    const first = test.context.jobs.claimNext(new Date().toISOString());
    const second = test.context.jobs.claimNext(new Date().toISOString());
    expect(first?.uuid).toBe(result.job.uuid);
    expect(first?.attemptCount).toBe(1);
    expect(second).toBeNull();
    expect(test.context.jobs.transition(result.job.uuid, 'SENT').status).toBe('SENT');
  });

  it('does not claim scheduled work before it is due', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context);
    const due = new Date(Date.now() + 60_000);
    const result = await test.context.messages.enqueue({
      destination: '120363000000000000@g.us',
      text: 'later',
      scheduledAt: due,
    });
    expect(test.context.jobs.claimNext(new Date().toISOString())).toBeNull();
    expect(test.context.jobs.promoteDueScheduled(new Date(due.valueOf() + 1).toISOString())).toBe(1);
    expect(test.context.jobs.get(result.job.uuid)?.status).toBe('PENDING');
  });

  it('rejects invalid state transitions', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context);
    const result = await test.context.messages.enqueue({
      destination: '120363000000000000@g.us',
      text: 'invalid transition',
    });
    expect(() => test!.context.jobs.transition(result.job.uuid, 'SENT')).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('persists manual retry state and resets the attempt budget', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context);
    const result = await test.context.messages.enqueue({
      destination: '120363000000000000@g.us',
      text: 'retry me',
    });
    test.context.jobs.claimNext(new Date().toISOString());
    test.context.jobs.transition(result.job.uuid, 'FAILED');
    const retried = test.context.jobs.retry(result.job.uuid);
    expect(retried.status).toBe('RETRY');
    expect(retried.attemptCount).toBe(0);
    expect(retried.nextAttemptAt).not.toBeNull();
  });

  it('cancels pending jobs when their destination is denied', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const result = await test.context.messages.enqueue({ destination: 'work', text: 'cancel' });
    test.context.destinations.setEnabled('work', false);
    expect(test.context.jobs.get(result.job.uuid)?.status).toBe('CANCELLED');
  });
});

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeliveryError } from '../src/domain/errors.js';
import type { Clock } from '../src/domain/types.js';
import { DryRunTransport } from '../src/messaging/dry-run-transport.js';
import { FakeTransport } from '../src/messaging/fake-transport.js';
import { QueueWorker } from '../src/messaging/queue-worker.js';
import { BaileysTransport } from '../src/whatsapp/transport.js';
import { addAllowedGroup, makeTestContext, type TestContext } from './helpers/context.js';

function worker(test: TestContext, transport: FakeTransport | DryRunTransport, clock?: Clock) {
  return new QueueWorker(
    test.context.jobs,
    test.context.destinations,
    test.context.state,
    test.context.audit,
    transport,
    test.context.config,
    test.context.logger,
    clock,
    () => 0.5,
  );
}

describe('queue worker', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('persists a transient retry and succeeds on the next attempt', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const created = await test.context.messages.enqueue({ destination: 'work', text: 'retry' });
    let current = new Date('2026-01-01T00:00:00.000Z');
    const clock: Clock = { now: () => current };
    const transport = new FakeTransport([
      new DeliveryError('TEMPORARY_NETWORK', 'temporary'),
      { remoteMessageId: 'fake:sent', dryRun: false },
    ]);
    const queueWorker = worker(test, transport, clock);
    await queueWorker.processOnce();
    const retry = test.context.jobs.get(created.job.uuid);
    expect(retry?.status).toBe('RETRY');
    expect(retry?.attemptCount).toBe(1);
    expect(retry?.nextAttemptAt).not.toBeNull();
    current = new Date(new Date(retry!.nextAttemptAt!).valueOf() + 1);
    await queueWorker.processOnce();
    const sent = test.context.jobs.get(created.job.uuid);
    expect(sent?.status).toBe('SENT');
    expect(sent?.attemptCount).toBe(2);
    expect(sent?.remoteMessageId).toBe('fake:sent');
  });

  it('persists rate-limit state and honors retry-after before success', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const created = await test.context.messages.enqueue({ destination: 'work', text: 'paced' });
    let current = new Date('2026-01-01T00:00:00.000Z');
    const clock: Clock = { now: () => current };
    const transport = new FakeTransport([
      new DeliveryError('RATE_LIMITED', 'wait', { retryAfterMs: 500 }),
      { remoteMessageId: 'fake:after-rate-limit', dryRun: false },
    ]);
    const queueWorker = worker(test, transport, clock);
    await queueWorker.processOnce();
    const waiting = test.context.jobs.get(created.job.uuid);
    expect(waiting?.status).toBe('WAITING_RATE_LIMIT');
    expect(test.context.state.get('outgoing_pause_reason')).toBe('RATE_LIMITED');
    expect(await queueWorker.processOnce()).toBe(false);
    current = new Date(new Date(waiting!.nextAttemptAt!).valueOf() + 1);
    await queueWorker.processOnce();
    expect(test.context.jobs.get(created.job.uuid)?.status).toBe('SENT');
  });

  it('conservatively bounds an unknown transient error', async () => {
    test = makeTestContext({ maxAttempts: 1 });
    addAllowedGroup(test.context, { alias: 'work' });
    const created = await test.context.messages.enqueue({ destination: 'work', text: 'unknown' });
    const transport = new FakeTransport([
      new DeliveryError('UNKNOWN_TRANSIENT', 'unrecognized transport failure'),
    ]);
    await worker(test, transport).processOnce();
    expect(test.context.jobs.get(created.job.uuid)).toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      lastErrorClass: 'UNKNOWN_TRANSIENT',
    });
  });

  it.each([
    ['DESTINATION_ERROR', true],
    ['PERMISSION_ERROR', true],
    ['INVALID_PAYLOAD', false],
  ] as const)('fails permanent %s without retry', async (errorClass, disablesDestination) => {
    test = makeTestContext();
    const destination = addAllowedGroup(test.context);
    const created = await test.context.messages.enqueue({ destination: destination.jid, text: 'fail' });
    const transport = new FakeTransport([new DeliveryError(errorClass, 'permanent')]);
    await worker(test, transport).processOnce();
    expect(test.context.jobs.get(created.job.uuid)?.status).toBe('FAILED');
    expect(test.context.destinations.resolve(destination.jid)?.canSend).toBe(!disablesDestination);
  });

  it('pauses safely for AUTH_REQUIRED and never marks the job delivered', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context);
    const created = await test.context.messages.enqueue({
      destination: '120363000000000000@g.us',
      text: 'auth',
    });
    const transport = new FakeTransport([new DeliveryError('AUTH_REQUIRED', 'login required')]);
    const queueWorker = worker(test, transport);
    await queueWorker.processOnce();
    expect(test.context.jobs.get(created.job.uuid)?.status).toBe('RETRY');
    expect(test.context.state.get('outgoing_pause_reason')).toBe('AUTH_REQUIRED');
    expect(queueWorker.isRunning).toBe(false);
    expect(await queueWorker.processOnce()).toBe(false);
  });

  it.each(['text', 'media'] as const)(
    'dry-runs %s through the worker without invoking Baileys sendMessage',
    async (kind) => {
      test = makeTestContext({ dryRun: true });
      addAllowedGroup(test.context, { alias: 'work' });
      const mediaPath = join(test.root, 'image.jpg');
      writeFileSync(mediaPath, 'fixture');
      const created = await test.context.messages.enqueue({
        destination: 'work',
        ...(kind === 'text' ? { text: 'dry text' } : { mediaPath, text: 'dry media' }),
      });
      test.context.state.set('outgoing_pause_reason', 'AUTH_REQUIRED');
      const sendMessage = vi.fn();
      const unusedBaileysTransport = new BaileysTransport(
        () => ({ sendMessage }) as never,
      );
      expect(unusedBaileysTransport.name).toBe('baileys');
      const dryRun = new DryRunTransport();
      await worker(test, dryRun).processOnce();
      expect(test.context.jobs.get(created.job.uuid)?.status).toBe('DRY_RUN');
      expect(test.context.jobs.get(created.job.uuid)?.remoteMessageId).toBe(
        `dryrun:${created.job.uuid}`,
      );
      expect(sendMessage).toHaveBeenCalledTimes(0);
      expect(dryRun.sendCalls).toEqual([created.job.uuid]);
    },
  );
});

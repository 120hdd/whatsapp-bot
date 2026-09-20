import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppContext } from '../src/app-context.js';
import type { AppConfig } from '../src/config/schema.js';
import { DeliveryError } from '../src/domain/errors.js';
import type { Clock } from '../src/domain/types.js';
import { FakeTransport } from '../src/messaging/fake-transport.js';
import { QueueWorker } from '../src/messaging/queue-worker.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), 'sajadbot-wa-retry-'));
const config: AppConfig = {
  databasePath: join(root, 'app.db'), stateDir: root, mediaDir: join(root, 'media'),
  lockPath: join(root, 'lock'), logLevel: 'silent', timezone: 'UTC', dryRun: false,
  workerPollMs: 50, sendIntervalMs: 0, maxAttempts: 3, retryBaseMs: 100,
  retryMaxMs: 1000, maxMediaBytes: 1_000_000, selfControllerEnabled: false,
};

try {
  const context = createAppContext(config);
  context.destinations.synchronize([{ jid: '120363000000000000@g.us', subject: 'Retry' }]);
  context.destinations.setEnabled('120363000000000000@g.us', true);
  const created = await context.messages.enqueue({
    destination: '120363000000000000@g.us', text: 'retry smoke',
  });
  let now = new Date('2026-01-01T00:00:00.000Z');
  const clock: Clock = { now: () => now };
  const fake = new FakeTransport([
    new DeliveryError('TEMPORARY_NETWORK', 'simulated network error'),
    { remoteMessageId: 'fake:success', dryRun: false },
  ]);
  const worker = new QueueWorker(
    context.jobs, context.destinations, context.state, context.audit,
    fake, config, context.logger, clock, () => 0.5,
  );
  await worker.processOnce();
  const retry = context.jobs.get(created.job.uuid);
  assert(retry?.status === 'RETRY' && retry.nextAttemptAt, 'attempt 1 did not persist RETRY');
  now = new Date(new Date(retry.nextAttemptAt).valueOf() + 1);
  await worker.processOnce();
  const sent = context.jobs.get(created.job.uuid);
  assert(sent?.status === 'SENT' && sent.attemptCount === 2, 'attempt 2 did not succeed');

  const authJob = await context.messages.enqueue({
    destination: '120363000000000000@g.us', text: 'auth pause smoke',
  });
  const authFake = new FakeTransport([new DeliveryError('AUTH_REQUIRED', 'simulated auth error')]);
  const authWorker = new QueueWorker(
    context.jobs, context.destinations, context.state, context.audit,
    authFake, config, context.logger, clock, () => 0.5,
  );
  await authWorker.processOnce();
  const authState = context.jobs.get(authJob.job.uuid);
  assert(authState?.status === 'RETRY', 'auth job was not safely preserved');
  assert(context.state.get('outgoing_pause_reason') === 'AUTH_REQUIRED', 'worker did not pause for auth');
  process.stdout.write(`${JSON.stringify({
    result: 'PASS', attempt1: 'RETRY', retryPersisted: true, attempt2: 'SENT',
    attemptCount: sent.attemptCount, authResult: authState.status,
    workerPauseReason: context.state.get('outgoing_pause_reason'), falselyDelivered: false,
  }, null, 2)}\n`);
  context.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

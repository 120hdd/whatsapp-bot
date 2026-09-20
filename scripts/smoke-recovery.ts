import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppContext } from '../src/app-context.js';
import type { AppConfig } from '../src/config/schema.js';
import { FakeTransport } from '../src/messaging/fake-transport.js';
import { QueueWorker } from '../src/messaging/queue-worker.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), 'sajadbot-wa-recovery-'));
const config: AppConfig = {
  databasePath: join(root, 'app.db'), stateDir: root, mediaDir: join(root, 'media'),
  lockPath: join(root, 'lock'), logLevel: 'silent', timezone: 'UTC', dryRun: false,
  workerPollMs: 50, sendIntervalMs: 0, maxAttempts: 3, retryBaseMs: 100,
  retryMaxMs: 1000, maxMediaBytes: 1_000_000, selfControllerEnabled: false,
};

try {
  let context = createAppContext(config);
  context.destinations.synchronize([{ jid: '120363000000000000@g.us', subject: 'Recovery' }]);
  context.destinations.setEnabled('120363000000000000@g.us', true);
  const created = await context.messages.enqueue({
    destination: '120363000000000000@g.us', text: 'uncertain delivery',
  });
  context.jobs.claimNext(new Date().toISOString());
  context.close();

  context = createAppContext(config);
  const recovered = context.jobs.recoverStaleProcessing();
  const fake = new FakeTransport();
  const worker = new QueueWorker(
    context.jobs, context.destinations, context.state, context.audit,
    fake, config, context.logger,
  );
  const processed = await worker.processOnce();
  assert(recovered === 1, 'expected one recovered job');
  assert(context.jobs.get(created.job.uuid)?.status === 'REVIEW_REQUIRED', 'job was not quarantined');
  assert(!processed && fake.sendCalls.length === 0, 'recovered job was automatically resent');
  const resolved = context.jobs.markSent(created.job.uuid, 'smoke');
  assert(resolved.status === 'SENT', 'manual resolution failed');
  process.stdout.write(`${JSON.stringify({
    result: 'PASS', recovered, recoveredState: 'REVIEW_REQUIRED', automaticallyResent: false,
    manualResolution: resolved.status,
  }, null, 2)}\n`);
  context.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createAppContext } from '../src/app-context.js';
import type { AppConfig } from '../src/config/schema.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), 'sajadbot-wa-smoke-'));
const config: AppConfig = {
  databasePath: join(root, 'app.db'),
  stateDir: root,
  mediaDir: join(root, 'media'),
  lockPath: join(root, 'daemon.lock'),
  logLevel: 'silent',
  timezone: 'Asia/Tehran',
  dryRun: true,
  workerPollMs: 50,
  sendIntervalMs: 0,
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 1000,
  maxMediaBytes: 10_000_000,
  selfControllerEnabled: false,
};
const envFile = join(root, '.env');
writeFileSync(
  envFile,
  [
    `DATABASE_PATH=${config.databasePath}`,
    `STATE_DIR=${config.stateDir}`,
    `MEDIA_DIR=${config.mediaDir}`,
    `LOCK_PATH=${config.lockPath}`,
    'LOG_LEVEL=silent',
    'TIMEZONE=Asia/Tehran',
    'DRY_RUN=true',
    'SEND_INTERVAL_MS=0',
    'WORKER_POLL_MS=50',
    'RETRY_BASE_MS=100',
    'RETRY_MAX_MS=1000',
  ].join('\n'),
);

function cli(args: readonly string[]): string {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/index.ts', '--config', envFile, '--dry-run', ...args],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert(result.status === 0, result.stderr || `CLI failed: ${args.join(' ')}`);
  return result.stdout;
}

try {
  const context = createAppContext(config);
  context.destinations.synchronize(
    [{ jid: '120363000000000000@g.us', subject: 'Offline Dry Run' }],
    'smoke',
  );
  context.destinations.setAlias('120363000000000000@g.us', 'dry-run-test', 'smoke');
  context.destinations.setEnabled('dry-run-test', true, 'smoke');
  context.close();

  const textCommand = ['send', 'dry-run-test', '--text', 'SajadBot WhatsApp dry-run test'];
  const first = cli(textCommand);
  const duplicate = cli(textCommand);
  const forced = cli([...textCommand, '--force']);
  const media = cli([
    'send',
    'dry-run-test',
    '--file',
    resolve('tests/fixtures/image.jpg'),
    '--caption',
    'media dry-run',
  ]);
  assert(first.includes('DRY_RUN'), 'text job did not reach DRY_RUN');
  assert(duplicate.includes('Duplicate suppressed'), 'duplicate was not suppressed');
  assert(forced.includes('DRY_RUN'), '--force did not create a simulated job');
  assert(media.includes('DRY_RUN'), 'media job did not reach DRY_RUN');

  const verification = createAppContext(config);
  const jobs = verification.jobs.list({ limit: 20 });
  assert(jobs.length === 3, `expected 3 intentional jobs, got ${jobs.length}`);
  assert(jobs.every((job) => job.status === 'DRY_RUN'), 'not all jobs are DRY_RUN');
  assert(jobs.every((job) => job.remoteMessageId?.startsWith('dryrun:')), 'fake IDs are not explicit');
  const mediaJob = jobs.find((job) => job.payloadType === 'image');
  assert(mediaJob?.mediaHash && mediaJob.mediaPath, 'media was not hashed and staged');
  assert(
    verification.audit.list().filter((event) => event.eventType === 'dry_run_executed').length === 3,
    'dry-run audit events missing',
  );
  assert(!verification.auth.hasCredentials(), 'offline dry-run unexpectedly created auth state');
  verification.close();
  process.stdout.write(
    `${JSON.stringify({
      result: 'PASS',
      textState: 'DRY_RUN',
      mediaState: 'DRY_RUN',
      duplicateSuppressed: true,
      forceCreatedSecondJob: true,
      jobs: jobs.map((job) => ({ id: job.uuid, state: job.status, remoteId: job.remoteMessageId })),
      baileysSendMessageCalls: 0,
      authRequired: false,
    }, null, 2)}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

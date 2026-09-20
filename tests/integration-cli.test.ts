import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppContext } from '../src/app-context.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

function runCli(envFile: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/index.ts', '--config', envFile, ...args],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

describe('real CLI → service → SQLite → worker → DryRunTransport pipeline', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('executes offline dry-run, duplicate suppression, force, and media staging', () => {
    test = makeTestContext({ dryRun: true });
    const config = test.context.config;
    const envFile = join(test.root, '.env');
    writeFileSync(
      envFile,
      [
        `DATABASE_PATH=${config.databasePath}`,
        `STATE_DIR=${config.stateDir}`,
        `MEDIA_DIR=${config.mediaDir}`,
        `LOCK_PATH=${config.lockPath}`,
        'LOG_LEVEL=silent',
        'DRY_RUN=true',
        'SEND_INTERVAL_MS=0',
      ].join('\n'),
    );
    test.context.destinations.synchronize(
      [{ jid: '120363000000000000@g.us', subject: 'Dry Run' }],
      'test',
    );
    test.context.destinations.setAlias('120363000000000000@g.us', 'dry-run-test');
    test.context.destinations.setEnabled('dry-run-test', true);
    test.context.close();

    const first = runCli(envFile, [
      '--dry-run',
      'send',
      'dry-run-test',
      '--text',
      'SajadBot WhatsApp dry-run test',
    ]);
    const duplicate = runCli(envFile, [
      '--dry-run',
      'send',
      'dry-run-test',
      '--text',
      'SajadBot WhatsApp dry-run test',
    ]);
    const forced = runCli(envFile, [
      '--dry-run',
      'send',
      'dry-run-test',
      '--text',
      'SajadBot WhatsApp dry-run test',
      '--force',
    ]);
    const fixture = join(test.root, 'image.jpg');
    writeFileSync(fixture, 'offline image bytes');
    const media = runCli(envFile, [
      '--dry-run',
      'send',
      'dry-run-test',
      '--file',
      fixture,
      '--caption',
      'media dry-run',
    ]);
    for (const result of [first, duplicate, forced, media]) {
      expect(result.status, result.stderr).toBe(0);
    }
    expect(first.stdout).toContain('DRY_RUN');
    expect(duplicate.stdout).toContain('Duplicate suppressed');

    const verification = createAppContext(config);
    const jobs = verification.jobs.list({ limit: 10 });
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.status === 'DRY_RUN')).toBe(true);
    expect(jobs.every((job) => job.remoteMessageId?.startsWith('dryrun:'))).toBe(true);
    expect(jobs.find((job) => job.payloadType === 'image')?.mediaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verification.audit.list().filter((event) => event.eventType === 'dry_run_executed')).toHaveLength(3);
    expect(verification.auth.hasCredentials()).toBe(false);
    verification.close();
  }, 30_000);
});

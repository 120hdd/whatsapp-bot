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

  it('manages group sets and queues bulk sends from the terminal CLI', () => {
    test = makeTestContext();
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
        'DRY_RUN=false',
        'SEND_INTERVAL_MS=0',
      ].join('\n'),
    );
    const destinations = [
      ['120363000000000001@g.us', 'one'],
      ['120363000000000002@g.us', 'two'],
      ['120363000000000003@g.us', 'off'],
    ] as const;
    for (const [jid, alias] of destinations) {
      test.context.destinations.synchronize([{ jid, subject: alias }], 'test');
      test.context.destinations.setAlias(jid, alias, 'test');
    }
    test.context.destinations.setEnabled('one', true, 'test');
    test.context.destinations.setEnabled('two', true, 'test');
    test.context.close();

    const create = runCli(envFile, ['groupset', 'create', 'Team']);
    const add = runCli(envFile, ['groupset', 'add', 'team', 'one,two', 'off']);
    const list = runCli(envFile, ['groupset', 'list']);
    const show = runCli(envFile, ['groupset', 'show', 'team']);
    const sendAll = runCli(envFile, ['sendall', '--text', 'all message']);
    const sendMulti = runCli(envFile, ['sendmulti', 'one,two,one', '--text', 'multi message']);
    const sendSet = runCli(envFile, ['sendset', 'team', '--text', 'set message']);
    const duplicate = runCli(envFile, ['sendall', '--text', 'all message']);
    const forced = runCli(envFile, ['sendall', '--text', 'all message', '--force']);
    const invalid = runCli(envFile, ['sendmulti', 'one,missing', '--text', 'must abort']);

    for (const result of [create, add, list, show, sendAll, sendMulti, sendSet, duplicate, forced]) {
      expect(result.status, result.stderr).toBe(0);
    }
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('Multi-send aborted');
    expect(JSON.parse(add.stdout)).toMatchObject({ groupSet: 'team', added: 3 });
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ name: 'team', memberCount: 3 })]);
    const shown = JSON.parse(show.stdout) as { name: string; members: unknown[] };
    expect(shown.name).toBe('team');
    expect(shown.members).toHaveLength(3);
    const sendAllResult = JSON.parse(sendAll.stdout) as {
      batchId: string;
      targets: number;
      queued: number;
      skipped: number;
    };
    expect(sendAllResult).toMatchObject({ targets: 2, queued: 2, skipped: 1 });
    expect(JSON.parse(sendMulti.stdout)).toMatchObject({ targets: 2, queued: 2, duplicates: 1 });
    expect(JSON.parse(sendSet.stdout)).toMatchObject({
      groupSet: 'team',
      members: 3,
      eligible: 2,
      disabled: 1,
      queued: 2,
    });
    expect(JSON.parse(duplicate.stdout)).toMatchObject({ queued: 0, duplicates: 2 });
    expect(JSON.parse(forced.stdout)).toMatchObject({ queued: 2, duplicates: 0 });

    const batchId = sendAllResult.batchId;
    const batch = runCli(envFile, ['batch', batchId]);
    expect(batch.status, batch.stderr).toBe(0);
    expect(JSON.parse(batch.stdout)).toMatchObject({ id: batchId, type: 'sendall', counts: { PENDING: 2 } });

    const verification = createAppContext(config);
    expect(verification.jobs.list({ limit: 100 })).toHaveLength(8);
    expect(verification.jobs.list({ limit: 100 }).every((job) => job.requestedBy === 'cli')).toBe(true);
    expect(verification.groupSets.members('team')).toHaveLength(3);
    verification.close();
  }, 60_000);
});

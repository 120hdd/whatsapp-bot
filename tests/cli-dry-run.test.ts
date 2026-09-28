import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const JID = '120363000000000000@g.us';

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('wts dry-run send', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('simulates only the job it just enqueued, never an older queued job', () => {
    const root = mkdtempSync(join(tmpdir(), 'wts-cli-dry-run-'));
    roots.push(root);
    const envFile = join(root, '.env');
    const cli = (...args: string[]) => runCli(['--config', envFile, ...args]);

    // Real-delivery config. Install exits 1 here on purpose: without credentials the system
    // check reports authentication as failed, so only assert that setup itself completed.
    const install = cli('install', '--yes', '--production', '--skip-login');
    expect(install.stdout).toContain('Initial setup is complete');
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain('DRY_RUN=false');

    const importLocal = cli('groups', 'import-local', JID, '--subject', 'Test group');
    expect(importLocal.status, importLocal.stderr).toBe(0);
    const allow = cli('groups', 'allow', JID);
    expect(allow.status, allow.stderr).toBe(0);

    // Queued against the real-delivery config, so it stays pending like genuine backlog work.
    const first = cli('send', JID, '--text', 'first message');
    expect(first.status, first.stderr).toBe(0);
    const firstUuid = /Queued job (\S+) \(PENDING\)/.exec(first.stdout)?.[1];
    expect(firstUuid, first.stdout).toBeTruthy();

    const second = cli('--dry-run', '--json', 'send', JID, '--text', 'first message');
    expect(second.status, second.stderr).toBe(0);
    const simulated = JSON.parse(second.stdout) as {
      message: string;
      job: { id: string; status: string; dryRun: boolean };
      dryRunTransportCalls: number;
    };
    expect(simulated.message).toContain('DRY RUN ACTIVE');
    expect(simulated.job.id).not.toBe(firstUuid);
    expect(simulated.job.status).toBe('DRY_RUN');
    expect(simulated.job.dryRun).toBe(true);
    expect(simulated.dryRunTransportCalls).toBe(1);

    // The pre-existing backlog must survive the dry run untouched and still be deliverable.
    const older = cli('--json', 'queue', 'show', firstUuid!);
    expect(older.status, older.stderr).toBe(0);
    expect(JSON.parse(older.stdout)).toMatchObject({
      id: firstUuid,
      status: 'PENDING',
      remoteMessageId: null,
      attempts: '0/5',
    });
  }, 60_000);
});

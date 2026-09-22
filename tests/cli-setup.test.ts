import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('wts setup and diagnostics CLI', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('advertises commands and command-specific help', () => {
    const rootHelp = runCli(['--help']);
    const installHelp = runCli(['install', '--help']);
    const groupSetHelp = runCli(['groupset', '--help']);
    const sendAllHelp = runCli(['sendall', '--help']);

    expect(rootHelp.status, rootHelp.stderr).toBe(0);
    expect(rootHelp.stdout).toContain('Usage: wts');
    expect(rootHelp.stdout).toContain('install');
    expect(rootHelp.stdout).toContain('check');
    expect(rootHelp.stdout).toContain('update');
    expect(rootHelp.stdout).toContain('groupset');
    expect(rootHelp.stdout).toContain('sendall');
    expect(rootHelp.stdout).toContain('sendmulti');
    expect(rootHelp.stdout).toContain('sendset');
    expect(rootHelp.stdout).toContain('batch');
    expect(installHelp.status, installHelp.stderr).toBe(0);
    expect(installHelp.stdout).toContain('--yes');
    expect(installHelp.stdout).toContain('--skip-login');
    expect(installHelp.stdout).toContain('--production');
    expect(groupSetHelp.status, groupSetHelp.stderr).toBe(0);
    expect(groupSetHelp.stdout).toContain('add <name> <targets...>');
    expect(groupSetHelp.stdout).toContain('remove <name> <targets...>');
    expect(sendAllHelp.status, sendAllHelp.stderr).toBe(0);
    expect(sendAllHelp.stdout).toContain('--text <message>');
    expect(sendAllHelp.stdout).toContain('--force');
  });

  it('installs with safe defaults and reports a healthy offline setup', () => {
    const root = mkdtempSync(join(tmpdir(), 'wts-cli-setup-'));
    roots.push(root);
    const envFile = join(root, '.env');

    const install = runCli(['--config', envFile, 'install', '--yes', '--skip-login']);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain('Initial setup is complete');
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain('DRY_RUN=true');
    expect(existsSync(join(root, 'data', 'app.db'))).toBe(true);

    const check = runCli(['--config', envFile, '--json', 'check']);
    expect(check.status, check.stderr).toBe(0);
    const report = JSON.parse(check.stdout) as {
      status: string;
      healthy: boolean;
      checks: Array<{ id: string; severity: string }>;
    };
    expect(report.status).toBe('healthy');
    expect(report.healthy).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'database', severity: 'pass' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'media', severity: 'pass' }));
  }, 20_000);
});

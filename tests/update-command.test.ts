import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runUpdate } from '../src/cli/update-command.js';

describe('wts update', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function checkout(): string {
    const root = mkdtempSync(join(tmpdir(), 'wts-update-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sajadbot-whatsapp' }));
    writeFileSync(join(root, 'scripts', 'upgrade.sh'), '#!/usr/bin/env bash\n');
    return root;
  }

  it('pulls, validates, builds, and deploys in order', () => {
    const sourceDir = checkout();
    const calls: Array<{ command: string; args: readonly string[]; capture: boolean }> = [];
    const runner = vi.fn((command: string, args: readonly string[], _cwd: string, capture: boolean) => {
      calls.push({ command, args, capture });
      return { status: 0, stdout: '', stderr: '' };
    });

    expect(
      runUpdate({ sourceDir, platform: 'linux', uid: 0, runner, write: vi.fn() }),
    ).toEqual({ sourceDir });
    expect(calls).toEqual([
      { command: 'git', args: ['status', '--porcelain'], capture: true },
      { command: 'git', args: ['pull', '--ff-only'], capture: false },
      { command: 'npm', args: ['ci'], capture: false },
      { command: 'npm', args: ['run', 'typecheck'], capture: false },
      { command: 'npm', args: ['run', 'lint'], capture: false },
      { command: 'npm', args: ['test'], capture: false },
      { command: 'npm', args: ['run', 'build'], capture: false },
      { command: 'bash', args: [join(sourceDir, 'scripts', 'upgrade.sh')], capture: false },
    ]);
  });

  it('refuses to deploy a dirty checkout', () => {
    const sourceDir = checkout();
    const runner = vi.fn(() => ({ status: 0, stdout: ' M src/daemon.ts\n', stderr: '' }));

    expect(() => runUpdate({ sourceDir, platform: 'linux', uid: 0, runner, write: vi.fn() })).toThrow(
      'source checkout has local changes',
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('requires root on Linux', () => {
    expect(() => runUpdate({ sourceDir: checkout(), platform: 'linux', uid: 1000 })).toThrow(
      'sudo wts update',
    );
  });
});

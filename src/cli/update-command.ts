import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_SOURCE_RECORD = '/etc/sajadbot-whatsapp/source-path';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type CommandRunner = (command: string, args: readonly string[], cwd: string, capture: boolean) => CommandResult;

export interface UpdateOptions {
  sourceDir?: string;
  skipPull?: boolean;
  sourceRecordPath?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  runner?: CommandRunner;
  write?: (message: string) => void;
}

function defaultRunner(command: string, args: readonly string[], cwd: string, capture: boolean): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function recordedSource(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, 'utf8').trim();
  return value || undefined;
}

function validateSource(sourceDir: string): void {
  const packagePath = resolve(sourceDir, 'package.json');
  const upgradePath = resolve(sourceDir, 'scripts', 'upgrade.sh');
  if (!existsSync(packagePath) || !existsSync(upgradePath)) {
    throw new Error(`Invalid source checkout: ${sourceDir}. Expected package.json and scripts/upgrade.sh.`);
  }
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string };
  if (manifest.name !== 'sajadbot-whatsapp') {
    throw new Error(`Unexpected package in source checkout: ${manifest.name ?? 'unknown'}`);
  }
}

function runStep(
  runner: CommandRunner,
  write: (message: string) => void,
  sourceDir: string,
  label: string,
  command: string,
  args: readonly string[],
): void {
  write(`\n==> ${label}`);
  const result = runner(command, args, sourceDir, false);
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status ?? 'unknown'}`}`);
  }
}

export function runUpdate(options: UpdateOptions = {}): { sourceDir: string } {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  if (platform !== 'linux') throw new Error('wts update is supported only on Linux system installations.');
  if (uid !== 0) throw new Error('Run the update as root: sudo wts update');

  const sourceRecordPath = options.sourceRecordPath ?? DEFAULT_SOURCE_RECORD;
  const configuredSource = options.sourceDir ?? process.env.WTS_SOURCE_DIR ?? recordedSource(sourceRecordPath);
  if (!configuredSource) {
    throw new Error(`No source checkout is configured. Run: sudo wts update --source /path/to/whatsappBot`);
  }
  const sourceDir = resolve(configuredSource);
  validateSource(sourceDir);

  const runner = options.runner ?? defaultRunner;
  const write = options.write ?? ((message: string) => process.stdout.write(`${message}\n`));
  const skipPull = options.skipPull ?? false;

  if (!skipPull) {
    const status = runner('git', ['status', '--porcelain'], sourceDir, true);
    if (status.error || status.status !== 0) {
      throw new Error(`Unable to inspect the source checkout: ${status.stderr.trim() || status.error?.message || 'git status failed'}`);
    }
    if (status.stdout.trim()) {
      throw new Error('The source checkout has local changes. Commit, stash, or remove them before running wts update.');
    }
    runStep(runner, write, sourceDir, 'Pulling the latest reviewed commit', 'git', ['pull', '--ff-only']);
  } else {
    write('\n==> Skipping git pull; deploying the current checkout');
  }

  runStep(runner, write, sourceDir, 'Installing exact dependencies', 'npm', ['ci']);
  runStep(runner, write, sourceDir, 'Running typecheck', 'npm', ['run', 'typecheck']);
  runStep(runner, write, sourceDir, 'Running lint', 'npm', ['run', 'lint']);
  runStep(runner, write, sourceDir, 'Running tests', 'npm', ['test']);
  runStep(runner, write, sourceDir, 'Building production files', 'npm', ['run', 'build']);
  runStep(runner, write, sourceDir, 'Installing the update and restarting the service', 'bash', [
    resolve(sourceDir, 'scripts', 'upgrade.sh'),
  ]);
  write('\nUpdate completed successfully.');
  return { sourceDir };
}

import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export class AlreadyRunningError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AlreadyRunningError';
  }
}

interface LockData {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ProcessLock {
  private held = false;

  public constructor(private readonly path: string) {}

  public acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(this.path, 'wx', 0o600);
        try {
          writeFileSync(
            descriptor,
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockData),
            'utf8',
          );
        } finally {
          closeSync(descriptor);
        }
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = this.readExisting();
        if (existing && isProcessAlive(existing.pid)) {
          throw new AlreadyRunningError(`Daemon is already running with PID ${existing.pid}`);
        }
        if (!existing) {
          let ageMs: number;
          try {
            ageMs = Date.now() - statSync(this.path).mtimeMs;
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw statError;
          }
          if (ageMs < 30_000) {
            throw new AlreadyRunningError('Daemon lock exists but is not yet readable');
          }
        }
        rmSync(this.path, { force: true });
      }
    }
    throw new AlreadyRunningError('Unable to acquire daemon process lock');
  }

  public release(): void {
    if (!this.held) return;
    const existing = this.readExisting();
    if (existing?.pid === process.pid) rmSync(this.path, { force: true });
    this.held = false;
  }

  private readExisting(): LockData | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LockData>;
      if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    } catch {
      return null;
    }
  }
}

import { accessSync, constants, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import dotenv from 'dotenv';

import { ConfigurationError } from '../domain/errors.js';
import { type AppConfig, configSchema } from './schema.js';

export interface ConfigOverrides {
  dryRun?: boolean;
  databasePath?: string;
  stateDir?: string;
  mediaDir?: string;
  lockPath?: string;
}

function absolutePath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

export function loadConfig(
  options: { envFile?: string; overrides?: ConfigOverrides; cwd?: string } = {},
): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const envFile = options.envFile ? absolutePath(options.envFile, cwd) : resolve(cwd, '.env');
  dotenv.config({ path: envFile, quiet: true });
  const env = process.env;
  const overrides = options.overrides ?? {};
  const parsed = configSchema.safeParse({
    databasePath: overrides.databasePath ?? env.DATABASE_PATH ?? './data/app.db',
    stateDir: overrides.stateDir ?? env.STATE_DIR ?? './data',
    mediaDir: overrides.mediaDir ?? env.MEDIA_DIR ?? './data/media',
    lockPath: overrides.lockPath ?? env.LOCK_PATH ?? './data/daemon.lock',
    logLevel: (env.LOG_LEVEL ?? 'info').toLowerCase(),
    timezone: env.TIMEZONE ?? 'UTC',
    dryRun: overrides.dryRun ?? env.DRY_RUN ?? false,
    workerPollMs: env.WORKER_POLL_MS ?? 1000,
    sendIntervalMs: env.SEND_INTERVAL_MS ?? 8000,
    maxAttempts: env.MAX_ATTEMPTS ?? 5,
    retryBaseMs: env.RETRY_BASE_MS ?? 5000,
    retryMaxMs: env.RETRY_MAX_MS ?? 300_000,
    maxMediaBytes: env.MAX_MEDIA_BYTES ?? 2_147_483_648,
    selfControllerEnabled: env.SELF_CONTROLLER_ENABLED ?? false,
    pairingPhone: env.PAIRING_PHONE || undefined,
  });
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid configuration: ${parsed.error.message}`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timezone }).format();
  } catch {
    throw new ConfigurationError(`Unknown TIMEZONE: ${parsed.data.timezone}`);
  }
  if (parsed.data.retryMaxMs < parsed.data.retryBaseMs) {
    throw new ConfigurationError('RETRY_MAX_MS must be greater than or equal to RETRY_BASE_MS');
  }
  return {
    ...parsed.data,
    databasePath: absolutePath(parsed.data.databasePath, cwd),
    stateDir: absolutePath(parsed.data.stateDir, cwd),
    mediaDir: absolutePath(parsed.data.mediaDir, cwd),
    lockPath: absolutePath(parsed.data.lockPath, cwd),
  };
}

export function ensureApplicationDirectories(config: AppConfig): void {
  for (const directory of [config.stateDir, config.mediaDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      accessSync(directory, constants.R_OK | constants.W_OK);
    } catch {
      throw new ConfigurationError(`Application directory is not readable/writable: ${directory}`);
    }
  }
}

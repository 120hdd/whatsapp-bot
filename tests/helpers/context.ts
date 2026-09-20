import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAppContext, type AppContext } from '../../src/app-context.js';
import type { AppConfig } from '../../src/config/schema.js';

export function testConfig(root: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databasePath: join(root, 'app.db'),
    stateDir: root,
    mediaDir: join(root, 'media'),
    lockPath: join(root, 'daemon.lock'),
    logLevel: 'silent',
    timezone: 'UTC',
    dryRun: false,
    workerPollMs: 50,
    sendIntervalMs: 0,
    maxAttempts: 3,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    maxMediaBytes: 10_000_000,
    selfControllerEnabled: false,
    ...overrides,
  };
}

export interface TestContext {
  root: string;
  context: AppContext;
  cleanup(): void;
}

export function makeTestContext(overrides: Partial<AppConfig> = {}): TestContext {
  const root = mkdtempSync(join(tmpdir(), 'sajadbot-wa-test-'));
  const context = createAppContext(testConfig(root, overrides));
  return {
    root,
    context,
    cleanup: () => {
      context.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function addAllowedGroup(context: AppContext, options: { subject?: string; alias?: string } = {}) {
  const jid = '120363000000000000@g.us';
  context.destinations.synchronize(
    [{ jid, subject: options.subject ?? 'Test group', participantCount: 3 }],
    'test',
  );
  if (options.alias) context.destinations.setAlias(jid, options.alias, 'test');
  return context.destinations.setEnabled(jid, true, 'test');
}

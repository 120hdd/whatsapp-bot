import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppContext } from '../src/app-context.js';
import { migrations } from '../src/db/migrations/index.js';
import { makeTestContext, testConfig, type TestContext } from './helpers/context.js';

describe('database and migrations', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('migrates an empty database and tracks every version', () => {
    test = makeTestContext();
    expect(existsSync(test.context.config.databasePath)).toBe(true);
    expect(test.context.database.getSchemaVersion()).toBe(migrations.at(-1)?.version);
  });

  it('enables WAL and foreign keys', () => {
    test = makeTestContext();
    expect(test.context.database.getJournalMode()).toBe('wal');
    expect(
      test.context.database.requireConnection().pragma('foreign_keys', { simple: true }),
    ).toBe(1);
  });

  it('rolls back an immediate transaction on failure', () => {
    test = makeTestContext();
    expect(() =>
      test!.context.database.immediateTransaction(() => {
        test!.context.state.set('rollback-test', 'present');
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(test.context.state.get('rollback-test')).toBeNull();
  });

  it('upgrades an existing version-2 database without losing destinations', () => {
    const root = mkdtempSync(join(tmpdir(), 'sajadbot-v2-migration-'));
    const databasePath = join(root, 'app.db');
    const legacy = new BetterSqlite3(databasePath);
    try {
      legacy.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      for (const migration of migrations.slice(0, 2)) {
        legacy.exec(migration.sql);
        legacy.prepare(
          'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(
          migration.version,
          migration.name,
          createHash('sha256').update(migration.sql).digest('hex'),
          new Date().toISOString(),
        );
      }
      const now = new Date().toISOString();
      legacy.prepare(
        `INSERT INTO destinations(
          jid, subject, enabled, can_send, created_at, updated_at, last_refreshed_at
        ) VALUES (?, ?, 1, 1, ?, ?, ?)`,
      ).run('120363000000000099@g.us', 'Preserved', now, now, now);
      legacy.close();

      const context = createAppContext(testConfig(root));
      try {
        expect(context.database.getSchemaVersion()).toBe(3);
        expect(context.destinations.resolve('120363000000000099@g.us')?.subject).toBe('Preserved');
        expect(context.groupSets.list()).toEqual([]);
      } finally {
        context.close();
      }
    } finally {
      if (legacy.open) legacy.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

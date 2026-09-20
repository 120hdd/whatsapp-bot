import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { migrations } from '../src/db/migrations/index.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

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
});

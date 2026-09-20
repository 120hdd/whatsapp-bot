import { afterEach, describe, expect, it } from 'vitest';

import { useSQLiteAuthState } from '../src/whatsapp/auth-state.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

describe('SQLite Baileys auth state', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('serializes credentials and key updates with BufferJSON compatibility', async () => {
    test = makeTestContext();
    const first = await useSQLiteAuthState(test.context.auth);
    first.state.creds.registered = true;
    await first.saveCreds();
    const key = { public: new Uint8Array([1, 2]), private: new Uint8Array([3, 4]) };
    await first.state.keys.set({ 'pre-key': { '7': key } });

    const restored = await useSQLiteAuthState(test.context.auth);
    expect(restored.state.creds.registered).toBe(true);
    const restoredKeys = await restored.state.keys.get('pre-key', ['7']);
    expect(Array.from(restoredKeys['7']?.public ?? [])).toEqual(Array.from(key.public));
    expect(Array.from(restoredKeys['7']?.private ?? [])).toEqual(Array.from(key.private));
  });

  it('removes deleted signal keys without clearing credentials', async () => {
    test = makeTestContext();
    const state = await useSQLiteAuthState(test.context.auth);
    state.state.creds.registered = true;
    await state.saveCreds();
    await state.state.keys.set({
      'pre-key': { '8': { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
    });
    await state.state.keys.set({ 'pre-key': { '8': null } });
    expect(await state.state.keys.get('pre-key', ['8'])).toEqual({});
    expect(test.context.auth.hasCredentials()).toBe(true);
  });

  it('rolls back batched key storage on a transaction failure', () => {
    test = makeTestContext();
    expect(() =>
      test!.context.database.immediateTransaction(() => {
        const db = test!.context.database.requireConnection();
        db.prepare(
          `INSERT INTO wa_auth_keys(category, key_id, value_json, updated_at)
           VALUES ('pre-key', 'partial', '{}', ?)`,
        ).run(new Date().toISOString());
        throw new Error('simulated auth transaction failure');
      }),
    ).toThrow('simulated auth transaction failure');
    expect(test.context.auth.getKeys('pre-key', ['partial'])).toEqual({});
  });
});

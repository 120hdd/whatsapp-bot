import { afterEach, describe, expect, it } from 'vitest';

import { AlreadyRunningError, ProcessLock } from '../src/lock/process-lock.js';
import { parseSchedule } from '../src/messaging/scheduler.js';
import { isGroupJid, isUserJid, normalizeJid, sameJid } from '../src/whatsapp/jid.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

describe('JIDs, schedules, and process locking', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('centralizes PN, LID, and group normalization', () => {
    expect(normalizeJid('989121234567@s.whatsapp.net')).toBe('989121234567@s.whatsapp.net');
    expect(normalizeJid('123456789@lid')).toBe('123456789@lid');
    expect(isUserJid('123456789@lid')).toBe(true);
    expect(isGroupJid('120363000000000000@g.us')).toBe(true);
    expect(normalizeJid('123:4@s.whatsapp.net')).toBe('123@s.whatsapp.net');
    expect(sameJid('123:4@s.whatsapp.net', '123@s.whatsapp.net')).toBe(true);
  });

  it('requires an explicit schedule offset and rejects the past', () => {
    expect(() => parseSchedule('2027-01-01T12:00:00')).toThrow('explicit UTC offset');
    expect(() => parseSchedule('2020-01-01T12:00:00Z')).toThrow('future');
    expect(parseSchedule('2030-01-01T12:00:00+03:30').toISOString()).toBe(
      '2030-01-01T08:30:00.000Z',
    );
  });

  it('rejects a second daemon lock and releases only its own lock', () => {
    test = makeTestContext();
    const first = new ProcessLock(test.context.config.lockPath);
    const second = new ProcessLock(test.context.config.lockPath);
    first.acquire();
    expect(() => second.acquire()).toThrow(AlreadyRunningError);
    first.release();
    expect(() => second.acquire()).not.toThrow();
    second.release();
  });
});

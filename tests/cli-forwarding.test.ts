import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { proto } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppContext } from '../src/app-context.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

function runCli(envFile: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/index.ts', '--config', envFile, ...args],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

describe('forward CLI', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('lists stored sources and queues single, multi, set, all, and scheduled forwards', () => {
    test = makeTestContext();
    const config = test.context.config;
    const envFile = join(test.root, '.env');
    writeFileSync(envFile, [
      `DATABASE_PATH=${config.databasePath}`,
      `STATE_DIR=${config.stateDir}`,
      `MEDIA_DIR=${config.mediaDir}`,
      `LOCK_PATH=${config.lockPath}`,
      'LOG_LEVEL=silent',
      'DRY_RUN=false',
      'SEND_INTERVAL_MS=0',
    ].join('\n'));
    const first = '120363000000000001@g.us';
    const second = '120363000000000002@g.us';
    const disabled = '120363000000000003@g.us';
    for (const [jid, alias] of [[first, 'family'], [second, 'work'], [disabled, 'off']] as const) {
      test.context.destinations.synchronize([{ jid, subject: alias }], 'test');
      test.context.destinations.setAlias(jid, alias, 'test');
    }
    test.context.destinations.setEnabled(first, true, 'test');
    test.context.destinations.setEnabled(second, true, 'test');
    test.context.groupSets.create('customers');
    test.context.groupSets.addMembers('customers', [first, second, disabled]);
    const selfJid = '989121234567@s.whatsapp.net';
    for (let number = 1; number <= 5; number += 1) {
      const id = `source-${number}`;
      const payload = proto.WebMessageInfo.encode({
        key: { id, fromMe: true, remoteJid: selfJid },
        message: { extendedTextMessage: {
          text: `forwarded ${number}`,
          contextInfo: { isForwarded: true, forwardingScore: 1 },
        } },
      }).finish();
      test.context.forwardSources.save({
        sourceKey: `${selfJid}|${id}`,
        payload: Buffer.from(payload),
        contentType: 'text',
        receivedAt: new Date().toISOString(),
        expiresAt: null,
      });
    }
    test.context.forwardSources.save({
      sourceKey: `${selfJid}|expired-media`,
      payload: Buffer.from(proto.WebMessageInfo.encode({
        key: { id: 'expired-media', fromMe: true, remoteJid: selfJid },
        message: { imageMessage: { contextInfo: { isForwarded: true } } },
      }).finish()),
      contentType: 'image',
      receivedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    });
    test.context.close();

    const sources = runCli(envFile, ['forwardsources']);
    const single = runCli(envFile, ['forward', 'family', '--source', 'source-1']);
    const multi = runCli(envFile, ['forwardmulti', 'family,work', '--source', 'source-2']);
    const set = runCli(envFile, ['forwardset', 'customers', '--source', 'source-3']);
    const all = runCli(envFile, ['forwardall', '--source', 'source-4']);
    const scheduled = runCli(envFile, [
      'forward', 'family', '--source', 'source-5', '--at', '2030-01-01T10:00:00Z',
    ]);
    for (const result of [sources, single, multi, set, all, scheduled]) {
      expect(result.status, result.stderr).toBe(0);
    }
    expect(JSON.parse(sources.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 'source-1', contentType: 'text' }),
    ]));
    expect(JSON.parse(single.stdout)).toMatchObject({ queued: 1, failed: 0 });
    expect(JSON.parse(multi.stdout)).toMatchObject({ queued: 2, failed: 0 });
    expect(JSON.parse(set.stdout)).toMatchObject({ queued: 2, skipped: 1, failed: 0 });
    expect(JSON.parse(all.stdout)).toMatchObject({ queued: 2, skipped: 1, failed: 0 });
    expect(JSON.parse(scheduled.stdout)).toMatchObject({ queued: 1, status: 'SCHEDULED' });

    const duplicate = runCli(envFile, ['forward', 'family', '--source', 'source-1']);
    const invalid = runCli(envFile, ['forwardmulti', 'family,missing', '--source', 'source-2']);
    const missing = runCli(envFile, ['forward', 'family', '--source', 'absent']);
    const expired = runCli(envFile, ['forward', 'family', '--source', 'expired-media']);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({ queued: 0, duplicates: 1 });
    expect(invalid.status).toBe(1);
    expect(missing.status).toBe(1);
    expect(expired.status).toBe(1);

    const verification = createAppContext(config);
    try {
      const jobs = verification.jobs.list({ limit: 20 });
      expect(jobs).toHaveLength(8);
      expect(jobs.every((job) => job.forwardSourceKey?.includes('|source-'))).toBe(true);
      expect(jobs.filter((job) => job.status === 'SCHEDULED')).toHaveLength(1);
    } finally {
      verification.close();
    }
  }, 45_000);
});

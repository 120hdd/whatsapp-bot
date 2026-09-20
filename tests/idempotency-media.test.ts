import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addAllowedGroup, makeTestContext, type TestContext } from './helpers/context.js';

describe('idempotency and media staging', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('suppresses identical requests and --force creates an intentional duplicate', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const first = await test.context.messages.enqueue({ destination: 'work', text: 'same' });
    const duplicate = await test.context.messages.enqueue({ destination: 'work', text: 'same' });
    const forced = await test.context.messages.enqueue({
      destination: 'work',
      text: 'same',
      force: true,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.job.uuid).toBe(first.job.uuid);
    expect(forced.duplicate).toBe(false);
    expect(forced.job.uuid).not.toBe(first.job.uuid);
  });

  it('changes identity for destination and normalized text changes', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'one' });
    test.context.destinations.synchronize(
      [{ jid: '120363000000000001@g.us', subject: 'Second' }],
      'test',
    );
    test.context.destinations.setEnabled('120363000000000001@g.us', true);
    const first = await test.context.messages.enqueue({ destination: 'one', text: 'body' });
    const changedText = await test.context.messages.enqueue({ destination: 'one', text: 'body changed' });
    const changedDestination = await test.context.messages.enqueue({
      destination: '120363000000000001@g.us',
      text: 'body',
    });
    expect(new Set([first.job.idempotencyKey, changedText.job.idempotencyKey, changedDestination.job.idempotencyKey]).size).toBe(3);
  });

  it('uses file contents rather than original filenames and stages managed media', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const firstPath = join(test.root, 'first.jpg');
    const secondPath = join(test.root, 'renamed.jpg');
    writeFileSync(firstPath, 'identical-image-bytes');
    copyFileSync(firstPath, secondPath);
    const first = await test.context.messages.enqueue({ destination: 'work', mediaPath: firstPath });
    const second = await test.context.messages.enqueue({ destination: 'work', mediaPath: secondPath });
    expect(second.duplicate).toBe(true);
    expect(second.job.uuid).toBe(first.job.uuid);
    expect(first.job.mediaPath).not.toBe(firstPath);
    expect(first.job.mediaHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('database uniqueness suppresses concurrent duplicate enqueue', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'work' });
    const results = await Promise.all([
      test.context.messages.enqueue({ destination: 'work', text: 'racing' }),
      test.context.messages.enqueue({ destination: 'work', text: 'racing' }),
    ]);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(test.context.jobs.list()).toHaveLength(1);
  });
});

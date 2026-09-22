import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppContext, type AppContext } from '../src/app-context.js';
import { FakeTransport } from '../src/messaging/fake-transport.js';
import { QueueWorker } from '../src/messaging/queue-worker.js';
import { createControllerExecutor } from '../src/whatsapp/controller-commands.js';
import type { WhatsAppGroupService } from '../src/whatsapp/group-service.js';
import { makeTestContext, testConfig, type TestContext } from './helpers/context.js';

const jids = [
  '120363000000000001@g.us',
  '120363000000000002@g.us',
  '120363000000000003@g.us',
  '120363000000000004@g.us',
] as const;

function executor(context: AppContext) {
  const groups = { refresh: vi.fn() } as unknown as WhatsAppGroupService;
  return createControllerExecutor(context, groups);
}

function addGroup(
  context: AppContext,
  jid: string,
  alias: string,
  enabled = true,
  subject = alias,
): void {
  context.destinations.synchronize([{ jid, subject }], 'test');
  context.destinations.setAlias(jid, alias, 'test');
  if (enabled) context.destinations.setEnabled(jid, true, 'test');
}

describe('bulk self-controller commands', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('reports an empty send-all without creating a batch or jobs', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'disabled', false);

    const response = await executor(test.context)('/sendall hello');

    expect(response).toContain('No allowed groups found');
    expect(test.context.jobs.list()).toHaveLength(0);
    expect(test.context.database.requireConnection().prepare('SELECT COUNT(*) AS count FROM message_batches').get())
      .toEqual({ count: 0 });
  });

  it('send-all snapshots allowed groups, skips disabled groups, and creates independent jobs', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    addGroup(test.context, jids[1], 'two');
    addGroup(test.context, jids[2], 'off', false);
    addGroup(test.context, jids[3], 'blocked');
    test.context.destinations.setCanSend(jids[3], false);

    const response = await executor(test.context)('/sendall سلام دوستان');
    const jobs = test.context.jobs.list();

    expect(response).toContain('Send-all queued');
    expect(response).toContain('Queued: 2');
    expect(response).toContain('Skipped: 2');
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.destinationJid))).toEqual(new Set([jids[0], jids[1]]));
    expect(jobs.every((job) => job.text === 'سلام دوستان' && job.batchId !== null)).toBe(true);
    expect(new Set(jobs.map((job) => job.batchId)).size).toBe(1);
    expect(new Set(jobs.map((job) => job.idempotencyKey)).size).toBe(2);
  });

  it('sendmulti accepts aliases, direct JIDs, comma whitespace, and canonical deduplication', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    addGroup(test.context, jids[1], 'two');

    const response = await executor(test.context)(
      `/sendmulti one, ${jids[1]}, one خط اول\nخط دوم فارسی`,
    );
    const jobs = test.context.jobs.list();

    expect(response).toContain('Queued: 2');
    expect(response).toContain('Duplicates: 1');
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.text === 'خط اول\nخط دوم فارسی')).toBe(true);
  });

  it.each([
    ['/sendmulti one,missing hello', 'missing — not found'],
    ['/sendmulti one,off hello', 'off — disabled'],
    ['/sendmulti one,blocked hello', 'blocked — not sendable'],
    ['/sendmulti one,bad@ hello', 'bad@ — invalid JID'],
    ['/sendmulti one,989121234567@s.whatsapp.net hello', '989121234567@s.whatsapp.net — not a group'],
  ])('sendmulti atomically aborts invalid input: %s', async (command, error) => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    addGroup(test.context, jids[1], 'off', false);
    addGroup(test.context, jids[2], 'blocked');
    test.context.destinations.setCanSend(jids[2], false);

    const response = await executor(test.context)(command);

    expect(response).toContain('Multi-send aborted');
    expect(response).toContain(error);
    expect(test.context.jobs.list()).toHaveLength(0);
  });

  it('reports idempotent duplicates per destination without failing the batch', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    addGroup(test.context, jids[1], 'two');
    const execute = executor(test.context);

    await execute('/sendmulti one,two same message');
    const response = await execute('/sendmulti one,two same message');

    expect(response).toContain('Queued: 0');
    expect(response).toContain('Duplicates: 2');
    expect(test.context.jobs.list()).toHaveLength(2);
  });

  it('delivers bulk jobs only through the normal queue worker path', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    addGroup(test.context, jids[1], 'two');
    await executor(test.context)('/sendmulti one,two queued path');
    const transport = new FakeTransport();
    const worker = new QueueWorker(
      test.context.jobs,
      test.context.destinations,
      test.context.state,
      test.context.audit,
      transport,
      test.context.config,
      test.context.logger,
    );

    expect(transport.sendCalls).toHaveLength(0);
    expect(await worker.processOnce()).toBe(true);
    expect(await worker.processOnce()).toBe(true);
    expect(transport.sendCalls.map((job) => job.destinationJid).sort()).toEqual([...jids.slice(0, 2)].sort());
    expect(test.context.jobs.list().every((job) => job.status === 'SENT')).toBe(true);
  });

  it('rejects empty bulk messages', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    const execute = executor(test.context);

    expect(await execute('/sendall   ')).toContain('Usage: /sendall');
    expect(await execute('/sendmulti one   ')).toContain('Usage: /sendmulti');
    expect(await execute('/sendset set   ')).toContain('Usage: /sendset');
    expect(test.context.jobs.list()).toHaveLength(0);
  });

  it('documents the new commands and exposes persisted batch status', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    const execute = executor(test.context);

    const help = await execute('/help');
    expect(help).toContain('/sendmulti TARGET1,TARGET2 MESSAGE');
    expect(help).toContain('/sendall MESSAGE');
    expect(help).toContain('/groupset create NAME');
    expect(help).toContain('/sendset NAME MESSAGE');

    const response = await execute('/sendall hello');
    const batchId = response.match(/Batch: ([0-9a-f-]+)/)?.[1];
    expect(batchId).toBeTruthy();
    const batch = await execute(`/batch ${batchId}`);
    expect(batch).toContain('Targets: 1');
    expect(batch).toContain('PENDING: 1');
  });
});

describe('persistent group sets and sendset', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('creates, lists, adds, deduplicates, shows, removes, and deletes sets', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    addGroup(test.context, jids[1], 'two');
    const execute = executor(test.context);

    expect(await execute('/groupset create ADS')).toBe('✅ Group set created: ads');
    expect(await execute('/groupset create ads')).toContain('already exists');
    expect(await execute('/groupset add ads one two,one')).toContain('Added: 2');
    expect(await execute('/groupset add ads one')).toContain('Already present: 1');
    expect(() =>
      test!.context.database.requireConnection()
        .prepare('INSERT INTO group_set_members(group_set_id, destination_jid, created_at) VALUES (?, ?, ?)')
        .run(test!.context.groupSets.get('ads')!.id, jids[0], new Date().toISOString()),
    ).toThrow(/UNIQUE constraint failed/);
    expect(await execute('/groupset list')).toContain('ads — 2 groups');
    const shown = await execute('/groupset show ads');
    expect(shown).toContain('✅ one — one');
    expect(shown).toContain('Allowed: 2');
    expect(await execute('/groupset remove ads one')).toContain('Removed: 1');
    expect(await execute('/groupset remove ads one')).toContain('Not present: 1');

    const setId = test.context.groupSets.get('ads')!.id;
    expect(await execute('/groupset delete ads')).toBe('✅ Group set deleted: ads');
    expect(test.context.groupSets.get('ads')).toBeNull();
    expect(
      test.context.database.requireConnection()
        .prepare('SELECT COUNT(*) AS count FROM group_set_members WHERE group_set_id = ?')
        .get(setId),
    ).toEqual({ count: 0 });
  });

  it('validates all membership inputs before changing a set', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    const execute = executor(test.context);
    await execute('/groupset create team');

    const response = await execute('/groupset add team one missing');

    expect(response).toContain('aborted');
    expect(test.context.groupSets.members('team')).toEqual([]);
  });

  it('stores JIDs so alias and subject changes do not break membership', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'old-alias', true, 'Old subject');
    const execute = executor(test.context);
    await execute('/groupset create team');
    await execute('/groupset add team old-alias');

    test.context.destinations.setAlias(jids[0], 'new-alias', 'test');
    test.context.destinations.synchronize([{ jid: jids[0], subject: 'New subject' }], 'test');
    const shown = await execute('/groupset show team');

    expect(test.context.groupSets.members('team')?.[0]?.jid).toBe(jids[0]);
    expect(shown).toContain('new-alias — New subject');
  });

  it('keeps disabled members and sendset skips disabled and missing rows', async () => {
    test = makeTestContext();
    addGroup(test.context, jids[0], 'one');
    addGroup(test.context, jids[1], 'off');
    addGroup(test.context, jids[2], 'three');
    const execute = executor(test.context);
    await execute('/groupset create team');
    await execute('/groupset add team one off three');
    test.context.destinations.setEnabled('off', false, 'test');
    const set = test.context.groupSets.get('team')!;
    test.context.database.requireConnection()
      .prepare('INSERT INTO group_set_members(group_set_id, destination_jid, created_at) VALUES (?, ?, ?)')
      .run(set.id, jids[3], new Date().toISOString());

    const response = await execute('/sendset team hello');

    expect(response).toContain('Members: 4');
    expect(response).toContain('Eligible: 2');
    expect(response).toContain('Disabled: 1');
    expect(response).toContain('Missing: 1');
    expect(test.context.groupSets.members('team')).toHaveLength(4);
    expect(test.context.jobs.list()).toHaveLength(2);
  });

  it('handles empty and unknown sets without queueing', async () => {
    test = makeTestContext();
    const execute = executor(test.context);
    await execute('/groupset create empty');

    expect(await execute('/sendset empty hello')).toContain('No eligible groups');
    expect(await execute('/sendset unknown hello')).toContain('not found');
    expect(test.context.jobs.list()).toHaveLength(0);
  });

  it('persists sets and memberships across application restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'sajadbot-groupset-persistence-'));
    let context = createAppContext(testConfig(root));
    try {
      addGroup(context, jids[0], 'one');
      context.groupSets.create('persistent');
      context.groupSets.addMembers('persistent', [jids[0]]);
      context.close();

      context = createAppContext(testConfig(root));
      expect(context.groupSets.members('PERSISTENT')?.map((member) => member.jid)).toEqual([jids[0]]);
    } finally {
      context.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

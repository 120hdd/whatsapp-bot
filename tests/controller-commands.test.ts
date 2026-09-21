import { afterEach, describe, expect, it, vi } from 'vitest';

import { createControllerExecutor } from '../src/whatsapp/controller-commands.js';
import type { WhatsAppGroupService } from '../src/whatsapp/group-service.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

describe('self-chat controller commands', () => {
  let test: TestContext | undefined;

  afterEach(() => test?.cleanup());

  it('returns a complete Persian setup and command guide', async () => {
    test = makeTestContext();
    const groups = { refresh: vi.fn() } as unknown as WhatsAppGroupService;
    const execute = createControllerExecutor(test.context, groups);

    const help = await execute('/help');

    expect(help).toContain('راه‌اندازی یک گروه برای اولین بار');
    expect(help).toContain('/groups refresh');
    expect(help).toContain('/groups alias 120363012345678901@g.us family');
    expect(help).toContain('/groups allow family');
    expect(help).toContain('/send family سلام، این یک پیام آزمایشی است.');
    expect(help).toContain('/schedule family 2026-09-23T20:00:00+03:30');
    expect(help).toContain('/cancel JOB_ID');
  });

  it('supports group discovery, aliasing, allowlisting, and sending from self-chat', async () => {
    test = makeTestContext();
    const jid = '120363012345678901@g.us';
    test.context.destinations.synchronize([{ jid, subject: 'Family group' }], 'test');
    const refresh = vi.fn().mockResolvedValue(1);
    const groups = { refresh } as unknown as WhatsAppGroupService;
    const execute = createControllerExecutor(test.context, groups);

    expect(await execute('/groups refresh')).toContain('1 گروه');
    expect(refresh).toHaveBeenCalledWith('self-controller');

    const initialList = await execute('/groups');
    expect(initialList).toContain('⛔ غیرفعال');
    expect(initialList).toContain(`jid: ${jid}`);

    expect(await execute(`/groups alias ${jid} family`)).toContain('family');
    expect(await execute('/groups allow family')).toContain('مجاز شد');
    expect(test.context.destinations.resolve('family')?.enabled).toBe(true);

    const send = await execute('/send family سلام گروه');
    expect(send).toContain('Queued:');
    expect(test.context.jobs.list({ limit: 10 })).toEqual([
      expect.objectContaining({ destinationJid: jid, text: 'سلام گروه' }),
    ]);
  });
});

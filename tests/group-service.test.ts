import type { WASocket } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WhatsAppGroupService } from '../src/whatsapp/group-service.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

describe('WhatsApp group synchronization', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('stores immutable JIDs, metadata, and own-admin sendability while defaulting disabled', async () => {
    test = makeTestContext();
    const socket = {
      user: { id: '98912:7@s.whatsapp.net', lid: '12345@lid' },
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        '120363000000000000@g.us': {
          id: '120363000000000000@g.us',
          subject: 'Announcements',
          desc: 'Read carefully',
          announce: true,
          addressingMode: 'lid',
          participants: [{ id: '12345@lid', admin: 'admin' }],
        },
      }),
    } as unknown as WASocket;
    const count = await new WhatsAppGroupService(
      () => socket,
      test.context.destinations,
    ).refresh();
    const destination = test.context.destinations.resolve('120363000000000000@g.us');
    expect(count).toBe(1);
    expect(destination).toMatchObject({
      subject: 'Announcements',
      description: 'Read carefully',
      addressingMode: 'lid',
      enabled: false,
      canSend: true,
    });
  });

  it('does not destroy the existing cache when discovery fails', async () => {
    test = makeTestContext();
    test.context.destinations.synchronize([
      { jid: '120363000000000000@g.us', subject: 'Cached' },
    ]);
    const socket = {
      groupFetchAllParticipating: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as WASocket;
    await expect(
      new WhatsAppGroupService(() => socket, test.context.destinations).refresh(),
    ).rejects.toThrow('network down');
    expect(test.context.destinations.resolve('120363000000000000@g.us')?.subject).toBe('Cached');
  });
});

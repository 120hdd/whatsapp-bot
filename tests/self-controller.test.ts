import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelfChatController } from '../src/whatsapp/self-controller.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

function message(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      id: 'controller-1',
      fromMe: true,
      remoteJid: '989121234567@s.whatsapp.net',
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: '/status' },
    ...overrides,
  };
}

function fakeSocket() {
  const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'reply' } });
  const socket = {
    sendMessage,
    ev: { on: vi.fn(), off: vi.fn() },
  } as unknown as WASocket;
  return { socket, sendMessage };
}

describe('self-chat controller', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('accepts current own self-chat commands and deduplicates message IDs', async () => {
    test = makeTestContext();
    const { socket, sendMessage } = fakeSocket();
    const execute = vi.fn().mockResolvedValue('healthy');
    const controller = new SelfChatController(
      socket,
      ['989121234567@s.whatsapp.net', '123456@lid'],
      test.context.controller,
      execute,
      test.context.logger,
    );
    const event = { messages: [message()], type: 'notify' };
    expect(await controller.handleUpsert(event)).toBe(1);
    expect(await controller.handleUpsert(event)).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts an own LID self-chat identity', () => {
    test = makeTestContext();
    const { socket } = fakeSocket();
    const controller = new SelfChatController(
      socket,
      ['989121234567@s.whatsapp.net', '123456@lid'],
      test.context.controller,
      async () => 'ok',
      test.context.logger,
    );
    expect(
      controller.isAuthorized(
        message({ key: { id: 'lid', fromMe: true, remoteJid: '123456@lid' } }),
      ),
    ).toBe(true);
  });

  it.each([
    ['arbitrary DM', message({ key: { id: 'dm', fromMe: false, remoteJid: '111@s.whatsapp.net' } })],
    ['group', message({ key: { id: 'group', fromMe: true, remoteJid: '120363000000000000@g.us' } })],
    [
      'historical message',
      message({ key: { id: 'old', fromMe: true, remoteJid: '989121234567@s.whatsapp.net' }, messageTimestamp: 1 }),
    ],
    [
      'forwarded command',
      message({
        message: {
          extendedTextMessage: {
            text: '/status',
            contextInfo: { isForwarded: true, forwardingScore: 1 },
          },
        },
      }),
    ],
  ])('rejects %s', (_label, candidate) => {
    test = makeTestContext();
    const { socket } = fakeSocket();
    const controller = new SelfChatController(
      socket,
      ['989121234567@s.whatsapp.net', '123456@lid'],
      test.context.controller,
      async () => 'ok',
      test.context.logger,
    );
    expect(controller.isAuthorized(candidate)).toBe(false);
  });

  it('rejects history-sync upserts even for otherwise valid messages', async () => {
    test = makeTestContext();
    const { socket } = fakeSocket();
    const execute = vi.fn().mockResolvedValue('ok');
    const controller = new SelfChatController(
      socket,
      ['989121234567@s.whatsapp.net'],
      test.context.controller,
      execute,
      test.context.logger,
    );
    expect(await controller.handleUpsert({ messages: [message()], type: 'append' })).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});

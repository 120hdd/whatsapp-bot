import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelfChatController } from '../src/whatsapp/self-controller.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

type UpsertEvent = { messages: WAMessage[]; type: string; requestId?: string };

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
  const handlers = new Set<(event: UpsertEvent) => void>();
  const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'reply' } });
  const socket = {
    sendMessage,
    ev: {
      on: (_event: string, handler: (event: UpsertEvent) => void) => {
        handlers.add(handler);
      },
      off: (_event: string, handler: (event: UpsertEvent) => void) => {
        handlers.delete(handler);
      },
    },
  };
  return {
    socket: socket as unknown as WASocket,
    sendMessage,
    /** Deliver an upsert the way the Baileys emitter would. */
    emit: (event: UpsertEvent) => {
      for (const handler of [...handlers]) handler(event);
    },
    listenerCount: () => handlers.size,
  };
}

function controllerFor(test: TestContext, execute: (command: string) => Promise<string>) {
  return new SelfChatController(
    ['989121234567@s.whatsapp.net', '123456@lid'],
    test.context.controller,
    execute,
    test.context.logger,
  );
}

describe('self-chat controller', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('accepts current own self-chat commands and deduplicates message IDs', async () => {
    test = makeTestContext();
    const { socket, sendMessage } = fakeSocket();
    const execute = vi.fn().mockResolvedValue('healthy');
    const controller = controllerFor(test, execute);
    controller.attach(socket);
    const event = { messages: [message()], type: 'notify' };
    expect(await controller.handleUpsert(event)).toBe(1);
    expect(await controller.handleUpsert(event)).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts an own LID self-chat identity', () => {
    test = makeTestContext();
    const { socket } = fakeSocket();
    const controller = controllerFor(test, async () => 'ok');
    controller.attach(socket);
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
    const controller = controllerFor(test, async () => 'ok');
    controller.attach(socket);
    expect(controller.isAuthorized(candidate)).toBe(false);
  });

  it('rejects history-sync upserts even for otherwise valid messages', async () => {
    test = makeTestContext();
    const { socket } = fakeSocket();
    const execute = vi.fn().mockResolvedValue('ok');
    const controller = controllerFor(test, execute);
    controller.attach(socket);
    expect(await controller.handleUpsert({ messages: [message()], type: 'append' })).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('follows the socket across a reconnect and answers on the new one', async () => {
    test = makeTestContext();
    const first = fakeSocket();
    const second = fakeSocket();
    const execute = vi.fn().mockResolvedValue('healthy');
    const controller = controllerFor(test, execute);

    controller.attach(first.socket);
    expect(first.listenerCount()).toBe(1);

    // A reconnect swaps the socket object underneath the controller.
    controller.attach(second.socket);
    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(1);
    expect(controller.attached).toBe(true);

    second.emit({ messages: [message({ key: { id: 'after-reconnect', fromMe: true, remoteJid: '989121234567@s.whatsapp.net' } })], type: 'notify' });
    await vi.waitFor(() => expect(second.sendMessage).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.sendMessage).not.toHaveBeenCalled();
  });

  it('stops answering once detached', async () => {
    test = makeTestContext();
    const { socket, sendMessage, emit, listenerCount } = fakeSocket();
    const execute = vi.fn().mockResolvedValue('ok');
    const controller = controllerFor(test, execute);

    controller.attach(socket);
    controller.detach();
    expect(controller.attached).toBe(false);
    expect(listenerCount()).toBe(0);

    emit({ messages: [message()], type: 'notify' });
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

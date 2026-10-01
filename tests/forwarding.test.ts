import { generateForwardMessageContent, proto, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppContext } from '../src/app-context.js';
import { asSendableJob } from '../src/domain/jobs.js';
import { createControllerExecutor } from '../src/whatsapp/controller-commands.js';
import { SelfChatController } from '../src/whatsapp/self-controller.js';
import { BaileysTransport } from '../src/whatsapp/transport.js';
import type { WhatsAppGroupService } from '../src/whatsapp/group-service.js';
import { addAllowedGroup, makeTestContext, testConfig, type TestContext } from './helpers/context.js';

const ownJid = '989121234567@s.whatsapp.net';
const now = () => Math.floor(Date.now() / 1000);

function forwarded(id: string): WAMessage {
  return {
    key: { id, fromMe: true, remoteJid: ownJid },
    messageTimestamp: now(),
    message: { extendedTextMessage: {
      text: 'a forwarded message',
      contextInfo: { isForwarded: true, forwardingScore: 1 },
    } },
  };
}

function command(id: string, text: string, quotedId: string): WAMessage {
  return {
    key: { id, fromMe: true, remoteJid: ownJid },
    messageTimestamp: now(),
    message: { extendedTextMessage: { text, contextInfo: { stanzaId: quotedId } } },
  };
}

describe('native self-chat forwarding', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('stores a forwarded source before a reply command and survives restart', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'family' });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'remote-1' } });
    const socket = { sendMessage, ev: { on: vi.fn(), off: vi.fn() } } as unknown as WASocket;
    const groups = { refresh: async () => 0 } as WhatsAppGroupService;
    const controller = new SelfChatController(
      [ownJid], test.context.controller,
      createControllerExecutor(test.context, groups), test.context.logger,
      test.context.forwardSources,
    );
    controller.attach(socket);
    expect(await controller.handleUpsert({ messages: [forwarded('source-1')], type: 'notify' })).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(test.context.forwardSources.get(`${ownJid}|source-1`)).not.toBeNull();
    expect(await controller.handleUpsert({
      messages: [command('command-1', '/forward family', 'source-1')], type: 'notify',
    })).toBe(1);
    const queued = test.context.jobs.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.forwardSourceKey).toBe(`${ownJid}|source-1`);
    controller.detach();
    test.context.close();

    const reopened = createAppContext(testConfig(test.root));
    try {
      const job = reopened.jobs.claimNext(new Date().toISOString());
      expect(job).not.toBeNull();
      const transport = new BaileysTransport(() => socket, reopened.forwardSources);
      await transport.send(asSendableJob(job!));
      const payload = sendMessage.mock.calls.at(-1)?.[1] as { forward?: WAMessage };
      expect(payload.forward?.message?.extendedTextMessage?.text).toBe('a forwarded message');
      expect(payload.forward?.message?.extendedTextMessage?.contextInfo?.isForwarded).toBe(true);
      const generated = generateForwardMessageContent(payload.forward!);
      expect(generated.extendedTextMessage?.contextInfo?.isForwarded).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('never executes a forwarded command and reports missing reply sources', async () => {
    test = makeTestContext();
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'reply' } });
    const socket = { sendMessage, ev: { on: vi.fn(), off: vi.fn() } } as unknown as WASocket;
    const execute = vi.fn().mockResolvedValue('queued');
    const controller = new SelfChatController(
      [ownJid], test.context.controller, execute, test.context.logger,
      test.context.forwardSources,
    );
    controller.attach(socket);
    const malicious = forwarded('source-2');
    malicious.message!.extendedTextMessage!.text = '/sendall malicious';
    expect(await controller.handleUpsert({ messages: [malicious], type: 'notify' })).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(await controller.handleUpsert({
      messages: [command('command-2', '/forwardall', 'missing')], type: 'notify',
    })).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    const reply = sendMessage.mock.calls.at(-1)?.[1] as { text: string };
    expect(reply.text).toMatch(/missing or expired/);
  });

  it('queues only allowed forward targets and suppresses repeats', async () => {
    test = makeTestContext();
    const first = addAllowedGroup(test.context, { alias: 'family' });
    const secondJid = '120363000000000002@g.us';
    test.context.destinations.synchronize([{ jid: secondJid, subject: 'Work' }], 'test');
    test.context.destinations.setAlias(secondJid, 'work', 'test');
    test.context.destinations.setEnabled(secondJid, true, 'test');
    test.context.groupSets.create('customers');
    test.context.groupSets.addMembers('customers', [first.jid, secondJid]);
    const groups = { refresh: async () => 0 } as WhatsAppGroupService;
    const execute = createControllerExecutor(test.context, groups);
    const sourceKey = `${ownJid}|source-3`;

    expect(await execute('/forwardmulti family,work', sourceKey)).toContain('Queued: 2');
    expect(await execute('/forwardmulti family,work', sourceKey)).toContain('Queued: 0');
    expect(await execute('/forwardset customers', sourceKey)).toContain('Queued: 0');
    expect(await execute('/forwardall', sourceKey)).toContain('Queued: 0');
    expect(test.context.jobs.list()).toHaveLength(2);
    expect(test.context.jobs.list().every((job) => job.forwardSourceKey === sourceKey)).toBe(true);
  });

  it('fails expired media before invoking Baileys', async () => {
    test = makeTestContext();
    addAllowedGroup(test.context, { alias: 'family' });
    const source = forwarded('expired-photo');
    source.message = { imageMessage: { contextInfo: { isForwarded: true } } };
    const sourceKey = `${ownJid}|expired-photo`;
    test.context.forwardSources.save({
      sourceKey,
      payload: Buffer.from(proto.WebMessageInfo.encode(source).finish()),
      contentType: 'image',
      receivedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    });
    await test.context.messages.enqueueForward({ destination: 'family', sourceKey });
    const job = test.context.jobs.claimNext(new Date().toISOString());
    const sendMessage = vi.fn();
    const transport = new BaileysTransport(
      () => ({ sendMessage } as unknown as WASocket), test.context.forwardSources,
    );
    await expect(transport.send(asSendableJob(job!))).rejects.toMatchObject({
      errorClass: 'MEDIA_ERROR',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'document'] as const)(
    'stores and builds a native %s forward', async (kind) => {
      test = makeTestContext();
      addAllowedGroup(test.context, { alias: 'family' });
      const source = forwarded(`${kind}-source`);
      const contextInfo = { isForwarded: true, forwardingScore: 1 };
      if (kind === 'image') source.message = { imageMessage: { contextInfo } };
      if (kind === 'video') source.message = { videoMessage: { contextInfo } };
      if (kind === 'document') source.message = { documentMessage: { contextInfo } };
      const sendMessage = vi.fn().mockResolvedValue({ key: { id: 'delivered' } });
      const socket = { sendMessage, ev: { on: vi.fn(), off: vi.fn() } } as unknown as WASocket;
      const controller = new SelfChatController(
        [ownJid], test.context.controller, async () => 'ok', test.context.logger,
        test.context.forwardSources,
      );
      controller.attach(socket);
      expect(await controller.handleUpsert({ messages: [source], type: 'notify' })).toBe(0);
      const sourceKey = `${ownJid}|${kind}-source`;
      expect(test.context.forwardSources.get(sourceKey)?.contentType).toBe(kind);
      await test.context.messages.enqueueForward({ destination: 'family', sourceKey });
      const job = test.context.jobs.claimNext(new Date().toISOString());
      const transport = new BaileysTransport(() => socket, test.context.forwardSources);
      await transport.send(asSendableJob(job!));
      const payload = sendMessage.mock.calls.at(-1)?.[1] as { forward: WAMessage };
      const generated = generateForwardMessageContent(payload.forward);
      expect(generated[`${kind}Message` as keyof typeof generated]).toBeDefined();
      controller.detach();
    },
  );
});

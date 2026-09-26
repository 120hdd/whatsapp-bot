import { createHash } from 'node:crypto';

import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

import type { ControllerRepository } from '../db/repositories/index.js';
import { isUserJid, sameJid } from './jid.js';

export type ControllerExecutor = (command: string) => Promise<string>;

function messageText(message: WAMessage): string | null {
  return (
    message.message?.conversation ??
    message.message?.extendedTextMessage?.text ??
    null
  );
}

function isForwarded(message: WAMessage): boolean {
  const context = message.message?.extendedTextMessage?.contextInfo;
  return context?.isForwarded === true || (context?.forwardingScore ?? 0) > 0;
}

export class SelfChatController {
  private readonly startedAtSeconds = Math.floor(Date.now() / 1000);
  private socket: WASocket | null = null;
  private handler: ((event: { messages: WAMessage[]; type: string; requestId?: string }) => void) | null = null;

  public constructor(
    private readonly ownJids: readonly string[],
    private readonly repository: ControllerRepository,
    private readonly execute: ControllerExecutor,
    private readonly logger: Logger,
  ) {}

  public get attached(): boolean {
    return this.socket !== null && this.handler !== null;
  }

  /**
   * Follow the live socket. Every reconnect constructs a replacement socket,
   * so the upsert listener has to move with it; binding one socket for the
   * process lifetime leaves commands undelivered after the first reconnect.
   */
  public attach(socket: WASocket): void {
    if (this.socket === socket) return;
    this.detach();
    const handler = (event: { messages: WAMessage[]; type: string; requestId?: string }) => {
      void this.handleUpsert(event);
    };
    socket.ev.on('messages.upsert', handler);
    this.socket = socket;
    this.handler = handler;
  }

  public detach(): void {
    if (this.socket && this.handler) this.socket.ev.off('messages.upsert', this.handler);
    this.socket = null;
    this.handler = null;
  }

  public async handleUpsert(event: {
    messages: WAMessage[];
    type: string;
    requestId?: string;
  }): Promise<number> {
    if (event.type !== 'notify' || event.requestId) return 0;
    let accepted = 0;
    for (const message of event.messages) {
      if (!(await this.handleMessage(message))) continue;
      accepted += 1;
    }
    return accepted;
  }

  public isAuthorized(message: WAMessage): boolean {
    const remoteJid = message.key.remoteJid;
    const participant = message.key.participant;
    if (!message.key.fromMe || !remoteJid || !isUserJid(remoteJid)) return false;
    if (!this.ownJids.some((own) => sameJid(own, remoteJid))) return false;
    if (participant && !this.ownJids.some((own) => sameJid(own, participant))) return false;
    if (isForwarded(message)) return false;
    const timestamp = Number(message.messageTimestamp ?? 0);
    if (!Number.isFinite(timestamp) || timestamp < this.startedAtSeconds - 30) return false;
    return true;
  }

  private async handleMessage(message: WAMessage): Promise<boolean> {
    if (!this.isAuthorized(message)) return false;
    const socket = this.socket;
    const id = message.key.id;
    const text = messageText(message)?.trim();
    if (!socket || !id || !text?.startsWith('/')) return false;
    const commandHash = createHash('sha256').update(text).digest('hex');
    if (!this.repository.markProcessed(id, commandHash, new Date().toISOString())) return false;
    try {
      const reply = await this.execute(text);
      await socket.sendMessage(message.key.remoteJid!, { text: reply });
    } catch (error) {
      this.logger.warn({ err: error, controller_message_id: id }, 'self_controller_command_failed');
      try {
        await socket.sendMessage(message.key.remoteJid!, {
          text: 'Command failed. Use the CLI for recovery and inspect service logs.',
        });
      } catch (sendError) {
        this.logger.warn({ err: sendError, controller_message_id: id }, 'self_controller_reply_failed');
      }
    }
    return true;
  }
}

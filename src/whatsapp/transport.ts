import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys';

import { DeliveryError } from '../domain/errors.js';
import type { SendableJob } from '../domain/jobs.js';
import type { MessageTransport, SendResult } from '../messaging/transport.js';
import { classifyWhatsAppError } from './error-classifier.js';

export type SocketProvider = () => WASocket | null;

export class BaileysTransport implements MessageTransport {
  public readonly name = 'baileys';

  public constructor(private readonly socketProvider: SocketProvider) {}

  public async send(job: SendableJob): Promise<SendResult> {
    const socket = this.socketProvider();
    if (!socket) throw new DeliveryError('CONNECTION_CLOSED', 'WhatsApp is not connected');
    try {
      const payload = this.buildPayload(job);
      const result = await socket.sendMessage(job.destinationJid, payload);
      const remoteMessageId = result?.key.id;
      if (!remoteMessageId) {
        throw new DeliveryError('UNKNOWN_TRANSIENT', 'WhatsApp did not return a message identifier');
      }
      return { remoteMessageId, dryRun: false };
    } catch (error) {
      throw classifyWhatsAppError(error);
    }
  }

  private buildPayload(job: SendableJob): AnyMessageContent {
    if (job.payloadType === 'text') return { text: job.text ?? '' };
    if (!job.mediaPath) throw new DeliveryError('MEDIA_ERROR', 'Queued media path is missing');
    const caption = job.text ? { caption: job.text } : {};
    if (job.payloadType === 'image') return { image: { url: job.mediaPath }, ...caption };
    if (job.payloadType === 'video') return { video: { url: job.mediaPath }, ...caption };
    if (job.payloadType === 'audio') {
      return { audio: { url: job.mediaPath }, mimetype: job.mediaMime ?? 'audio/mpeg', ptt: false };
    }
    return {
      document: { url: job.mediaPath },
      mimetype: job.mediaMime ?? 'application/octet-stream',
      fileName: job.filename ?? 'attachment.bin',
      ...caption,
    };
  }
}

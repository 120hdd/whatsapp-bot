import { proto, type AnyMessageContent, type WASocket } from '@whiskeysockets/baileys';

import { DeliveryError } from '../domain/errors.js';
import type { SendableJob } from '../domain/jobs.js';
import type { ForwardSourceRepository } from '../db/repositories/forward-source-repository.js';
import type { MessageTransport, SendResult } from '../messaging/transport.js';
import { classifyWhatsAppError } from './error-classifier.js';

export type SocketProvider = () => WASocket | null;

export class BaileysTransport implements MessageTransport {
  public readonly name = 'baileys';

  public constructor(
    private readonly socketProvider: SocketProvider,
    private readonly forwardSources?: ForwardSourceRepository,
  ) {}

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
      const classified = classifyWhatsAppError(error);
      if (job.forwardSourceKey &&
          (classified.errorClass === 'DESTINATION_ERROR' || classified.errorClass === 'PERMISSION_ERROR')) {
        throw new DeliveryError(
          'INVALID_PAYLOAD',
          'WhatsApp could not forward the source; it may be unavailable or protected',
          { cause: error },
        );
      }
      throw classified;
    }
  }

  private buildPayload(job: SendableJob): AnyMessageContent {
    if (job.forwardSourceKey) {
      const source = this.forwardSources?.get(job.forwardSourceKey);
      if (!source) throw new DeliveryError('INVALID_PAYLOAD', 'Forward source is no longer stored');
      if (source.expiresAt && Date.now() >= Date.parse(source.expiresAt)) {
        throw new DeliveryError('MEDIA_ERROR', 'Forward source media reference expired; forward it to Message Yourself again');
      }
      const message = proto.WebMessageInfo.decode(source.payload);
      if (!message.key?.id || !message.message) {
        throw new DeliveryError('INVALID_PAYLOAD', 'Stored forward source is incomplete');
      }
      return { forward: message as unknown as import('@whiskeysockets/baileys').WAMessage };
    }
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

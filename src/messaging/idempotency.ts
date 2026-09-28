import { createHash } from 'node:crypto';

import type { PayloadType } from '../domain/jobs.js';

export function normalizeMessage(value: string | null | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').normalize('NFC').trim();
}

export interface IdempotencyInput {
  destinationJid: string;
  payloadType: PayloadType;
  text: string;
  mediaHash: string | null;
  scheduleIdentity: string;
  filename: string | null;
  options: Readonly<Record<string, unknown>>;
  forceNonce?: string;
  dryRun?: boolean;
}

export function buildIdempotencyKey(input: IdempotencyInput): string {
  const canonical = JSON.stringify({
    destinationJid: input.destinationJid,
    payloadType: input.payloadType,
    text: input.text,
    mediaHash: input.mediaHash,
    scheduleIdentity: input.scheduleIdentity,
    filename: input.filename,
    options: Object.fromEntries(Object.entries(input.options).sort(([a], [b]) => a.localeCompare(b))),
    forceNonce: input.forceNonce ?? null,
    ...(input.dryRun ? { dryRun: true } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

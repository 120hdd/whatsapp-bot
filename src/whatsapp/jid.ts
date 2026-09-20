import { jidDecode, jidEncode } from '@whiskeysockets/baileys';

const allowedServers = new Set(['s.whatsapp.net', 'g.us', 'lid', 'broadcast', 'newsletter']);

export function normalizeJid(value: string): string {
  const trimmed = value.trim();
  const decoded = jidDecode(trimmed);
  if (!decoded?.user || !decoded.server) throw new Error(`Invalid WhatsApp JID: ${value}`);
  const server = decoded.server.toLowerCase();
  if (!allowedServers.has(server) && !server.includes('.')) {
    throw new Error(`Unsupported WhatsApp JID server: ${server}`);
  }
  // Device-qualified user JIDs identify a companion endpoint, not a durable destination.
  // Canonical storage intentionally strips the device component.
  return jidEncode(decoded.user, decoded.server);
}

export function isGroupJid(value: string): boolean {
  try {
    return jidDecode(normalizeJid(value))?.server === 'g.us';
  } catch {
    return false;
  }
}

export function isUserJid(value: string): boolean {
  try {
    const server = jidDecode(normalizeJid(value))?.server;
    return server === 's.whatsapp.net' || server === 'lid';
  } catch {
    return false;
  }
}

export function sameJid(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  try {
    return normalizeJid(left) === normalizeJid(right);
  } catch {
    return false;
  }
}

import type { Destination } from './groups.js';

export interface GroupSet {
  id: number;
  name: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupSetMember {
  jid: string;
  createdAt: string;
  destination: Destination | null;
}

export interface MembershipChange {
  changed: number;
  unchanged: number;
}

export function normalizeGroupSetName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('Group set name must be 1-64 characters using letters, numbers, _ or -');
  }
  return normalized;
}

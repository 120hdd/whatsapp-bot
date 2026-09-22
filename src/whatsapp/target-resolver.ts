import type { DestinationRepository } from '../db/repositories/index.js';
import type { Destination } from '../domain/groups.js';
import { isGroupJid, normalizeJid } from './jid.js';

export type TargetIssueReason =
  | 'not found'
  | 'invalid JID'
  | 'not a group'
  | 'disabled'
  | 'not sendable';

export interface TargetIssue {
  input: string;
  reason: TargetIssueReason;
}

export interface ResolveTargetsResult {
  destinations: Destination[];
  issues: TargetIssue[];
  duplicates: number;
}

export interface AllowedSnapshot {
  destinations: Destination[];
  requested: number;
  skipped: number;
  duplicates: number;
}

export class TargetResolver {
  public constructor(private readonly destinations: DestinationRepository) {}

  public resolveTargets(inputs: readonly string[], requireAllowed: boolean): ResolveTargetsResult {
    const resolved: Destination[] = [];
    const issues: TargetIssue[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const rawInput of inputs) {
      const input = rawInput.trim();
      if (!input) continue;
      let destination: Destination | null;
      if (input.includes('@')) {
        let jid: string;
        try {
          jid = normalizeJid(input);
        } catch {
          issues.push({ input, reason: 'invalid JID' });
          continue;
        }
        if (!isGroupJid(jid)) {
          issues.push({ input, reason: 'not a group' });
          continue;
        }
        destination = this.destinations.resolve(jid);
      } else {
        destination = this.destinations.resolve(input);
      }
      if (!destination) {
        issues.push({ input, reason: 'not found' });
        continue;
      }
      if (!isGroupJid(destination.jid)) {
        issues.push({ input, reason: 'not a group' });
        continue;
      }
      if (requireAllowed && !destination.enabled) {
        issues.push({ input, reason: 'disabled' });
        continue;
      }
      if (requireAllowed && !destination.canSend) {
        issues.push({ input, reason: 'not sendable' });
        continue;
      }
      const jid = normalizeJid(destination.jid);
      if (seen.has(jid)) {
        duplicates += 1;
        continue;
      }
      seen.add(jid);
      resolved.push(destination);
    }
    return { destinations: resolved, issues, duplicates };
  }

  public snapshotAllowed(): AllowedSnapshot {
    const known = this.destinations.list();
    const eligible = known.filter((destination) => destination.enabled && destination.canSend);
    const resolved = this.resolveTargets(eligible.map((destination) => destination.jid), true);
    return {
      destinations: resolved.destinations,
      requested: known.length,
      skipped: known.length - eligible.length + resolved.issues.length,
      duplicates: resolved.duplicates,
    };
  }
}

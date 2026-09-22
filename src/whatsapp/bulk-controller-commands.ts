import type { AppContext } from '../app-context.js';
import { normalizeGroupSetName } from '../domain/group-sets.js';
import { TargetResolver, type TargetIssue } from './target-resolver.js';

function messageAfter(command: string, head: string): string | null {
  const match = command.match(new RegExp(`^${head}\\s+([\\s\\S]+)$`, 'i'));
  return match?.[1]?.trim() || null;
}

function namedMessage(command: string, head: string): { name: string; message: string } | null {
  const match = command.match(new RegExp(`^${head}\\s+(\\S+)\\s+([\\s\\S]+)$`, 'i'));
  const name = match?.[1];
  const message = match?.[2]?.trim();
  return name && message ? { name, message } : null;
}

function multiMessage(command: string): { targets: string[]; message: string } | null {
  const match = command.match(/^\/sendmulti\s+([^\s,]+(?:\s*,\s*[^\s,]+)*)\s+([\s\S]+)$/i);
  const expression = match?.[1];
  const message = match?.[2]?.trim();
  if (!expression || !message) return null;
  return { targets: expression.split(',').map((target) => target.trim()), message };
}

function invalidTargets(issues: readonly TargetIssue[]): string {
  return [
    '❌ Multi-send aborted.',
    '',
    'Invalid targets:',
    ...issues.map((issue) => `- ${issue.input} — ${issue.reason}`),
    '',
    'No messages were queued.',
  ].join('\n');
}

function bulkLines(
  title: string,
  result: Awaited<ReturnType<AppContext['bulkMessages']['enqueue']>>,
  extra: readonly string[] = [],
): string {
  return [
    `✅ ${title}`,
    '',
    ...extra,
    `Targets: ${result.targets}`,
    `Queued: ${result.queued}`,
    `Duplicates: ${result.duplicateJobs + result.duplicateTargets}`,
    `Failed: ${result.failed}`,
    `Batch: ${result.batchId}`,
  ].join('\n');
}

export class BulkControllerCommands {
  private readonly targets: TargetResolver;

  public constructor(private readonly context: AppContext) {
    this.targets = new TargetResolver(context.destinations);
  }

  public async sendMulti(command: string): Promise<string> {
    const parsed = multiMessage(command);
    if (!parsed) return '❌ Usage: /sendmulti TARGET1,TARGET2 MESSAGE';
    const resolved = this.targets.resolveTargets(parsed.targets, true);
    if (resolved.issues.length) return invalidTargets(resolved.issues);
    const result = await this.context.bulkMessages.enqueue({
      type: 'sendmulti',
      destinations: resolved.destinations,
      text: parsed.message,
      actor: 'self-controller',
      requestedCount: parsed.targets.length,
      duplicateTargets: resolved.duplicates,
    });
    return bulkLines('Multi-send queued', result);
  }

  public async sendAll(command: string): Promise<string> {
    const message = messageAfter(command, '/sendall');
    if (!message) return '❌ Usage: /sendall MESSAGE';
    const snapshot = this.targets.snapshotAllowed();
    if (!snapshot.destinations.length) return '⚠️ No allowed groups found.\nNothing was queued.';
    const result = await this.context.bulkMessages.enqueue({
      type: 'sendall',
      destinations: snapshot.destinations,
      text: message,
      actor: 'self-controller',
      requestedCount: snapshot.requested,
      duplicateTargets: snapshot.duplicates,
      skipped: snapshot.skipped,
    });
    return bulkLines('Send-all queued', result, [`Skipped: ${snapshot.skipped}`]);
  }

  public async sendSet(command: string): Promise<string> {
    const parsed = namedMessage(command, '/sendset');
    if (!parsed) return '❌ Usage: /sendset NAME MESSAGE';
    let name: string;
    try {
      name = normalizeGroupSetName(parsed.name);
    } catch {
      return '❌ Invalid group set name.';
    }
    const members = this.context.groupSets.members(name);
    if (!members) return `❌ Group set not found: ${name}`;
    const present = members.filter((member) => member.destination !== null);
    const resolved = this.targets.resolveTargets(present.map((member) => member.jid), true);
    const disabled = resolved.issues.filter(
      (issue) => issue.reason === 'disabled' || issue.reason === 'not sendable',
    ).length;
    const missing = members.length - present.length + resolved.issues.length - disabled;
    if (!resolved.destinations.length) {
      return `⚠️ No eligible groups in set: ${name}\nNothing was queued.`;
    }
    const result = await this.context.bulkMessages.enqueue({
      type: 'sendset',
      destinations: resolved.destinations,
      text: parsed.message,
      actor: 'self-controller',
      requestedCount: members.length,
      duplicateTargets: resolved.duplicates,
      skipped: disabled + missing,
    });
    return bulkLines(`Group set queued: ${name}`, result, [
      `Members: ${members.length}`,
      `Eligible: ${resolved.destinations.length}`,
      `Disabled: ${disabled}`,
      `Missing: ${missing}`,
    ]);
  }

  public batch(id: string): string {
    const batch = this.context.batches.get(id);
    if (!batch) return `❌ Batch not found: ${id}`;
    return [
      `Batch: ${batch.id}`,
      '',
      `Targets: ${batch.targetCount}`,
      ...Object.entries(batch.counts).map(([status, count]) => `${status}: ${count}`),
    ].join('\n');
  }
}

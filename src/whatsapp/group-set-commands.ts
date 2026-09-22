import type { AppContext } from '../app-context.js';
import { normalizeGroupSetName } from '../domain/group-sets.js';
import { TargetResolver } from './target-resolver.js';

function parse(command: string): { action: string; name?: string; targets: string[] } {
  const match = command.match(/^\/groupset(?:\s+([\s\S]+))?$/i);
  const parts = (match?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const action = parts.shift();
  if (!action) return { action: '', targets: [] };
  const name = parts.shift();
  return {
    action: action.toLowerCase(),
    ...(name ? { name } : {}),
    targets: parts.flatMap((part) => part.split(',')).map((target) => target.trim()).filter(Boolean),
  };
}

export class GroupSetCommands {
  private readonly targets: TargetResolver;

  public constructor(private readonly context: AppContext) {
    this.targets = new TargetResolver(context.destinations);
  }

  public execute(command: string): string {
    const parsed = parse(command);
    if (parsed.action === 'list') {
      if (parsed.name) return '❌ Usage: /groupset list';
      const sets = this.context.groupSets.list();
      if (!sets.length) return 'No group sets found.';
      return ['📁 Group Sets', '', ...sets.map((set) => `${set.name} — ${set.memberCount} groups`)].join('\n');
    }
    if (!parsed.name) return '❌ Usage: /groupset create|add|remove|show|delete NAME [TARGET...]';
    let name: string;
    try {
      name = normalizeGroupSetName(parsed.name);
    } catch {
      return '❌ Group set name must be 1-64 characters using letters, numbers, _ or -.';
    }
    if (parsed.action === 'create') {
      if (parsed.targets.length) return '❌ Usage: /groupset create NAME';
      const created = this.context.groupSets.create(name);
      return created ? `✅ Group set created: ${created.name}` : `❌ Group set already exists: ${name}`;
    }
    if (parsed.action === 'delete') {
      if (parsed.targets.length) return '❌ Usage: /groupset delete NAME';
      return this.context.groupSets.delete(name)
        ? `✅ Group set deleted: ${name}`
        : `❌ Group set not found: ${name}`;
    }
    if (parsed.action === 'show') {
      if (parsed.targets.length) return '❌ Usage: /groupset show NAME';
      return this.show(name);
    }
    if (parsed.action === 'add' || parsed.action === 'remove') {
      return this.modify(parsed.action, name, parsed.targets);
    }
    return '❌ Usage: /groupset create|add|remove|list|show|delete NAME [TARGET...]';
  }

  private show(name: string): string {
    const members = this.context.groupSets.members(name);
    if (!members) return `❌ Group set not found: ${name}`;
    const allowed = members.filter(
      (member) => member.destination?.enabled && member.destination.canSend,
    ).length;
    const missing = members.filter((member) => !member.destination).length;
    const disabled = members.length - allowed - missing;
    const lines = members.map((member) => {
      const destination = member.destination;
      if (!destination) return `❓ ${member.jid} — missing`;
      const label = destination.alias ?? member.jid;
      return `${destination.enabled && destination.canSend ? '✅' : '⛔'} ${label} — ${destination.subject}`;
    });
    return [
      `📁 ${name}`,
      '',
      `${members.length} groups`,
      '',
      ...lines,
      '',
      `Allowed: ${allowed}`,
      `Disabled: ${disabled}`,
      `Missing: ${missing}`,
    ].join('\n');
  }

  private modify(action: 'add' | 'remove', name: string, inputs: readonly string[]): string {
    if (!inputs.length) return `❌ Usage: /groupset ${action} NAME TARGET...`;
    if (!this.context.groupSets.get(name)) return `❌ Group set not found: ${name}`;
    const resolved = this.targets.resolveTargets(inputs, false);
    if (resolved.issues.length) {
      return [
        `❌ Group set ${action} aborted.`,
        '',
        'Invalid targets:',
        ...resolved.issues.map((issue) => `- ${issue.input} — ${issue.reason}`),
        '',
        'No changes were made.',
      ].join('\n');
    }
    const jids = resolved.destinations.map((destination) => destination.jid);
    const change = action === 'add'
      ? this.context.groupSets.addMembers(name, jids)
      : this.context.groupSets.removeMembers(name, jids);
    if (!change) return `❌ Group set not found: ${name}`;
    return [
      `✅ Updated group set: ${name}`,
      '',
      `${action === 'add' ? 'Added' : 'Removed'}: ${change.changed}`,
      `${action === 'add' ? 'Already present' : 'Not present'}: ${change.unchanged + resolved.duplicates}`,
    ].join('\n');
  }
}

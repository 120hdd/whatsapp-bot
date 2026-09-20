import type { AppContext } from '../app-context.js';
import { parseSchedule } from '../messaging/scheduler.js';
import type { WhatsAppGroupService } from './group-service.js';

function queueLines(context: AppContext, failedOnly: boolean): string {
  const statuses = failedOnly ? (['FAILED', 'REVIEW_REQUIRED'] as const) : undefined;
  const jobs = context.jobs.list({ ...(statuses ? { statuses } : {}), limit: 20 });
  if (!jobs.length) return 'Queue is empty.';
  return jobs
    .map((job) => `${job.uuid}  ${job.status}  ${job.destinationJid}  ${job.attemptCount}/${job.maxAttempts}`)
    .join('\n');
}

export function createControllerExecutor(
  context: AppContext,
  groups: WhatsAppGroupService,
): (command: string) => Promise<string> {
  return async (command: string): Promise<string> => {
    const [head, ...rest] = command.trim().split(/\s+/);
    if (head === '/status') return JSON.stringify(context.health.report(), null, 2);
    if (head === '/queue') return queueLines(context, rest[0] === 'failed');
    if (head === '/groups' && rest[0] === 'refresh') {
      const count = await groups.refresh('self-controller');
      return `Refreshed ${count} groups. Newly discovered groups remain disabled.`;
    }
    if (head === '/groups') {
      return context.destinations
        .list()
        .map((group) => `${group.enabled ? 'allowed' : 'denied'}  ${group.alias ?? '-'}  ${group.subject}`)
        .join('\n');
    }
    if (head === '/cancel' && rest[0]) {
      const job = context.jobs.cancel(rest[0], 'self-controller');
      return `Cancelled ${job.uuid}.`;
    }
    if (head === '/send' && rest.length >= 2) {
      const [destination, ...body] = rest;
      const result = await context.messages.enqueue({
        destination: destination!,
        text: body.join(' '),
        actor: 'self-controller',
      });
      return result.duplicate
        ? `Duplicate suppressed: ${result.job.uuid}`
        : `Queued: ${result.job.uuid}`;
    }
    if (head === '/schedule' && rest.length >= 3) {
      const [destination, at, ...body] = rest;
      const result = await context.messages.enqueue({
        destination: destination!,
        scheduledAt: parseSchedule(at!),
        text: body.join(' '),
        actor: 'self-controller',
      });
      return result.duplicate
        ? `Duplicate suppressed: ${result.job.uuid}`
        : `Scheduled: ${result.job.uuid}`;
    }
    return [
      'Commands:',
      '/status',
      '/queue [failed]',
      '/groups [refresh]',
      '/send <alias-or-jid> <text>',
      '/schedule <alias-or-jid> <ISO-8601-with-offset> <text>',
      '/cancel <job-id>',
    ].join('\n');
  };
}

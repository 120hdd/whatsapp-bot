#!/usr/bin/env node
import qrcode from 'qrcode-terminal';
import { Command } from 'commander';

import { createAppContext, type AppContext } from '../app-context.js';
import { ensureApplicationDirectories, loadConfig } from '../config/load.js';
import type { AppConfig } from '../config/schema.js';
import { runDaemon } from '../daemon.js';
import { ProcessLock } from '../lock/process-lock.js';
import { DryRunTransport } from '../messaging/dry-run-transport.js';
import { QueueWorker } from '../messaging/queue-worker.js';
import { formatInTimezone, parseSchedule } from '../messaging/scheduler.js';
import { ConnectionManager } from '../whatsapp/connection-manager.js';
import { WhatsAppGroupService } from '../whatsapp/group-service.js';
import { isGroupJid, normalizeJid } from '../whatsapp/jid.js';

interface GlobalOptions {
  config?: string;
  dryRun?: boolean;
  json?: boolean;
}

const program = new Command();

function getConfig(): AppConfig {
  const options = program.opts<GlobalOptions>();
  const dryRunSource = program.getOptionValueSource('dryRun');
  return loadConfig({
    ...(options.config ? { envFile: options.config } : {}),
    ...(dryRunSource === 'cli' ? { overrides: { dryRun: true } } : {}),
  });
}

async function withContext<T>(operation: (context: AppContext) => Promise<T> | T): Promise<T> {
  const config = getConfig();
  ensureApplicationDirectories(config);
  const context = createAppContext(config);
  try {
    return await operation(context);
  } finally {
    context.close();
  }
}

function output(value: unknown): void {
  if (program.opts<GlobalOptions>().json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function publicJob(job: ReturnType<AppContext['jobs']['get']>, includeContent = false): unknown {
  if (!job) return null;
  return {
    id: job.uuid,
    status: job.status,
    destinationJid: job.destinationJid,
    payloadType: job.payloadType,
    ...(includeContent ? { text: job.text, mediaPath: job.mediaPath } : {}),
    mediaHash: job.mediaHash,
    scheduledAt: job.scheduledAt,
    attempts: `${job.attemptCount}/${job.maxAttempts}`,
    nextAttemptAt: job.nextAttemptAt,
    lastErrorClass: job.lastErrorClass,
    lastErrorMessage: job.lastErrorMessage,
    remoteMessageId: job.remoteMessageId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function withConnectedManager<T>(
  context: AppContext,
  operation: (manager: ConnectionManager) => Promise<T>,
  options: { pairingPhone?: string; showQr?: boolean } = {},
): Promise<T> {
  const lock = new ProcessLock(context.config.lockPath);
  lock.acquire();
  const manager = new ConnectionManager(
    context.auth,
    context.state,
    context.audit,
    context.config,
    context.logger,
  );
  try {
    await manager.connect({
      autoReconnect: false,
      ...(options.pairingPhone ? { pairingPhone: options.pairingPhone } : {}),
      ...(options.showQr
        ? {
            onQr: (qr) => qrcode.generate(qr, { small: true }),
            onPairingCode: (code) => output(`Pairing code: ${code}`),
          }
        : {}),
    });
    return await operation(manager);
  } finally {
    await manager.disconnect();
    lock.release();
  }
}

async function enqueueAndMaybeDryRun(options: {
  destination: string;
  text?: string;
  file?: string;
  caption?: string;
  filename?: string;
  at?: string;
  force?: boolean;
}): Promise<void> {
  await withContext(async (context) => {
    const result = await context.messages.enqueue({
      destination: options.destination,
      ...(options.file ? { mediaPath: options.file } : {}),
      ...(options.filename ? { filename: options.filename } : {}),
      ...(options.file
        ? options.caption
          ? { text: options.caption }
          : {}
        : options.text
          ? { text: options.text }
          : {}),
      ...(options.at ? { scheduledAt: parseSchedule(options.at) } : {}),
      force: options.force ?? false,
      actor: 'cli',
    });
    if (result.duplicate) {
      output(`Duplicate suppressed. Existing job: ${result.job.uuid}`);
      return;
    }
    if (context.config.dryRun && result.job.status === 'PENDING') {
      const transport = new DryRunTransport();
      const worker = new QueueWorker(
        context.jobs,
        context.destinations,
        context.state,
        context.audit,
        transport,
        context.config,
        context.logger,
      );
      await worker.processOnce();
      const finished = context.jobs.get(result.job.uuid);
      output({
        message: 'DRY RUN ACTIVE — outbound WhatsApp sending is disabled',
        job: publicJob(finished),
        baileysSendMessageCalls: 0,
      });
      return;
    }
    output(`Queued job ${result.job.uuid} (${result.job.status})`);
  });
}

program
  .name('sajadbot-wa')
  .description('Durable allowlist-only WhatsApp linked-device queue worker')
  .version('1.0.0')
  .option('-c, --config <path>', 'environment file path')
  .option('--dry-run', 'disable all outbound WhatsApp delivery')
  .option('--json', 'emit machine-readable JSON');

program.command('start').description('Run the queue daemon in the foreground').action(async () => {
  const result = await runDaemon(getConfig());
  if (result === 'AUTH_REQUIRED') output('Authentication required. Run: sajadbot-wa auth login');
});

program.command('status').description('Show service, auth, and queue status').action(async () => {
  await withContext((context) => output(context.health.report()));
});

program.command('health').description('Check readiness without sending a message').action(async () => {
  await withContext((context) => {
    const report = context.health.report();
    output(report);
    if (!report.healthy) process.exitCode = 1;
  });
});

const auth = program.command('auth').description('Manage linked-device authentication');
auth
  .command('login')
  .description('Authenticate by QR or pairing code')
  .option('--pairing-phone <number>', 'phone with country code for pairing-code login')
  .action(async (options: { pairingPhone?: string }) => {
    await withContext(async (context) => {
      output('Waiting for WhatsApp linked-device authentication…');
      const pairingPhone = options.pairingPhone ?? context.config.pairingPhone;
      await withConnectedManager(
        context,
        async () => {
          context.audit.add('auth_login', { actor: 'cli' });
          output('WhatsApp authentication succeeded.');
        },
        {
          ...(pairingPhone ? { pairingPhone } : {}),
          showQr: true,
        },
      );
    });
  });
auth.command('status').description('Show local auth availability and last-known state').action(async () => {
  await withContext((context) =>
    output({
      auth: context.auth.hasCredentials() ? 'AVAILABLE' : 'REQUIRED',
      connectionState: context.state.get('connectivity') ?? 'DISCONNECTED',
      ownJid: context.state.get('own_jid'),
      lastConnectionAt: context.state.get('last_connection_at'),
    }),
  );
});
auth
  .command('logout')
  .description('Explicitly unlink and remove local credentials')
  .option('--local-only', 'remove local credentials when server logout is impossible')
  .action(async (options: { localOnly?: boolean }) => {
    await withContext(async (context) => {
      if (options.localOnly || !context.auth.hasCredentials()) {
        context.auth.clear();
        context.state.set('connectivity', 'AUTH_REQUIRED');
        context.state.set('outgoing_pause_reason', 'AUTH_REQUIRED');
        context.audit.add('auth_logout_local', { actor: 'cli' });
      } else {
        await withConnectedManager(context, async (manager) => manager.logout());
      }
      output('Local WhatsApp credentials removed. A new login is required.');
    });
  });

const groups = program.command('groups').description('Discover and manage group allowlisting');
groups.command('refresh').description('Refresh groups from WhatsApp transactionally').action(async () => {
  await withContext(async (context) => {
    const count = await withConnectedManager(context, async (manager) =>
      new WhatsAppGroupService(() => manager.currentSocket, context.destinations).refresh('cli'),
    );
    output(`Refreshed ${count} groups. Newly discovered groups remain disabled.`);
  });
});
groups.command('list').option('--allowed', 'show only allowlisted groups').action(async (options: { allowed?: boolean }) => {
  await withContext((context) => output(context.destinations.list(options.allowed ?? false)));
});
groups.command('show <reference>').action(async (reference: string) => {
  await withContext((context) => {
    const destination = context.destinations.resolve(reference);
    if (!destination) throw new Error(`Unknown destination: ${reference}`);
    output(destination);
  });
});
groups.command('allow <reference>').action(async (reference: string) => {
  await withContext((context) => output(context.destinations.setEnabled(reference, true)));
});
groups.command('deny <reference>').action(async (reference: string) => {
  await withContext((context) => output(context.destinations.setEnabled(reference, false)));
});
groups.command('alias <jid> <alias>').action(async (jid: string, alias: string) => {
  await withContext((context) => output(context.destinations.setAlias(normalizeJid(jid), alias)));
});
groups.command('unalias <reference>').action(async (reference: string) => {
  await withContext((context) => output(context.destinations.setAlias(reference, null)));
});
groups
  .command('import-local <jid>')
  .description('Seed a disabled group for offline dry-run preparation')
  .requiredOption('--subject <name>')
  .option('--alias <alias>')
  .action(async (jid: string, options: { subject: string; alias?: string }) => {
    await withContext((context) => {
      const normalized = normalizeJid(jid);
      if (!isGroupJid(normalized)) throw new Error('Only @g.us group JIDs may be imported');
      context.destinations.synchronize([{ jid: normalized, subject: options.subject }], 'cli-import');
      if (options.alias) context.destinations.setAlias(normalized, options.alias, 'cli-import');
      output(context.destinations.resolve(normalized));
    });
  });

program
  .command('send <destination>')
  .description('Queue an immediate message for an allowlisted destination')
  .option('--text <message>')
  .option('--file <path>')
  .option('--caption <caption>')
  .option('--filename <name>')
  .option('--force', 'allow an intentional duplicate')
  .action(
    async (
      destination: string,
      options: { text?: string; file?: string; caption?: string; filename?: string; force?: boolean },
    ) => enqueueAndMaybeDryRun({ destination, ...options }),
  );

program
  .command('schedule <destination>')
  .description('Queue a scheduled message; --at requires an explicit offset')
  .requiredOption('--at <timestamp>')
  .option('--text <message>')
  .option('--file <path>')
  .option('--caption <caption>')
  .option('--filename <name>')
  .option('--force', 'allow an intentional duplicate')
  .action(
    async (
      destination: string,
      options: {
        at?: string;
        text?: string;
        file?: string;
        caption?: string;
        filename?: string;
        force?: boolean;
      },
    ) => enqueueAndMaybeDryRun({ destination, ...options }),
  );

const queue = program.command('queue').description('Inspect and resolve durable jobs');
queue.command('list').option('--limit <count>', 'maximum rows', '100').action(async (options: { limit: string }) => {
  await withContext((context) => output(context.jobs.list({ limit: Number(options.limit) }).map((job) => publicJob(job))));
});
queue.command('show <id>').option('--include-content', 'include private text and staged path').action(
  async (id: string, options: { includeContent?: boolean }) => {
    await withContext((context) => {
      const job = context.jobs.get(id);
      if (!job) throw new Error(`Unknown job: ${id}`);
      output(publicJob(job, options.includeContent));
    });
  },
);
for (const [name, statuses] of [
  ['review', ['REVIEW_REQUIRED']],
  ['failed', ['FAILED']],
  ['pending', ['PENDING', 'SCHEDULED', 'RETRY', 'WAITING_RATE_LIMIT']],
] as const) {
  queue.command(name).action(async () => {
    await withContext((context) =>
      output(
        context.jobs
          .list({ statuses, limit: 100 })
          .map((job) => publicJob(job)),
      ),
    );
  });
}
queue.command('retry <id>').action(async (id: string) => {
  await withContext((context) => output(publicJob(context.jobs.retry(id))));
});
queue.command('cancel <id>').action(async (id: string) => {
  await withContext((context) => output(publicJob(context.jobs.cancel(id))));
});
queue.command('mark-sent <id>').description('Resolve an uncertain job as already delivered').action(async (id: string) => {
  await withContext((context) => output(publicJob(context.jobs.markSent(id))));
});

program.command('audit').description('Show recent control-plane events').option('--limit <count>', 'maximum rows', '100').action(
  async (options: { limit: string }) => {
    await withContext((context) => output(context.audit.list(Number(options.limit))));
  },
);

program.command('time <timestamp>').description('Display a stored UTC timestamp in configured timezone').action(
  (timestamp: string) => output(formatInTimezone(timestamp, getConfig().timezone)),
);

export async function main(argv = process.argv): Promise<void> {
  await program.parseAsync(argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown failure';
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

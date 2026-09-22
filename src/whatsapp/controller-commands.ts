import type { AppContext } from '../app-context.js';
import { parseSchedule } from '../messaging/scheduler.js';
import { BulkControllerCommands } from './bulk-controller-commands.js';
import type { WhatsAppGroupService } from './group-service.js';
import { GroupSetCommands } from './group-set-commands.js';

function queueLines(context: AppContext, failedOnly: boolean): string {
  const statuses = failedOnly ? (['FAILED', 'REVIEW_REQUIRED'] as const) : undefined;
  const jobs = context.jobs.list({ ...(statuses ? { statuses } : {}), limit: 20 });
  if (!jobs.length) return 'Queue is empty.';
  return jobs
    .map((job) => `${job.uuid}  ${job.status}  ${job.destinationJid}  ${job.attemptCount}/${job.maxAttempts}`)
    .join('\n');
}

function groupLines(context: AppContext): string {
  const destinations = context.destinations.list();
  if (!destinations.length) {
    return 'هنوز گروهی پیدا نشده است. ابتدا /groups refresh را بفرستید.';
  }
  return destinations
    .map(
      (group) =>
        `${group.enabled ? '✅ مجاز' : '⛔ غیرفعال'} | ${group.subject}\n` +
        `alias: ${group.alias ?? '-'}\n` +
        `jid: ${group.jid}`,
    )
    .join('\n\n');
}

function helpText(): string {
  return [
    '*راهنمای ارسال پیام به گروه*',
    '',
    'این فرمان‌ها فقط در Message Yourself همان حسابی کار می‌کنند که به بات متصل شده است.',
    '',
    '*راه‌اندازی یک گروه برای اولین بار*',
    '1) حساب WhatsApp متصل به بات را عضو گروه مقصد کنید.',
    '2) گروه‌ها را دریافت کنید:',
    '/groups refresh',
    '3) فهرست گروه‌ها و JID هر گروه را ببینید:',
    '/groups',
    '4) برای استفادهٔ راحت‌تر، یک نام کوتاه انگلیسی بدون فاصله بسازید:',
    '/groups alias 120363012345678901@g.us family',
    '5) گروه را صریحاً مجاز کنید:',
    '/groups allow family',
    '6) پیام بفرستید:',
    '/send family سلام، این یک پیام آزمایشی است.',
    '',
    '*فرمان‌ها*',
    '/help',
    'نمایش همین راهنما.',
    '',
    '/status',
    'نمایش وضعیت اتصال، Worker و صف.',
    '',
    '/groups refresh',
    'دریافت یا به‌روزرسانی گروه‌هایی که حساب بات عضو آن‌هاست. گروه جدید ابتدا غیرفعال می‌ماند.',
    '',
    '/groups',
    'نمایش نام، وضعیت، alias و JID همهٔ گروه‌ها.',
    '',
    '/groups alias JID ALIAS',
    'ساخت نام کوتاه برای گروه. alias فقط می‌تواند حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط داشته باشد.',
    'مثال: /groups alias 120363012345678901@g.us family',
    '',
    '/groups allow ALIAS_OR_JID',
    'اجازهٔ ارسال به گروه.',
    'مثال: /groups allow family',
    '',
    '/groups deny ALIAS_OR_JID',
    'توقف ارسال به گروه و لغو پیام‌های ارسال‌نشدهٔ آن.',
    'مثال: /groups deny family',
    '',
    '/send ALIAS_OR_JID MESSAGE',
    'قرار دادن یک پیام متنی در صف ارسال فوری.',
    'مثال: /send family جلسه ساعت ۸ شروع می‌شود.',
    '',
    '/sendmulti TARGET1,TARGET2 MESSAGE',
    'ارسال اتمی به چند گروه مجاز مشخص.',
    '/sendall MESSAGE',
    'ارسال به همهٔ گروه‌های مجاز فعلی.',
    '/groupset create NAME',
    '/groupset add NAME TARGET...',
    '/groupset remove NAME TARGET...',
    '/groupset list',
    '/groupset show NAME',
    '/groupset delete NAME',
    'مدیریت مجموعه‌های دائمی گروه‌ها. نام مجموعه بدون فاصله است و به حروف کوچک ذخیره می‌شود.',
    '/sendset NAME MESSAGE',
    'ارسال به اعضای مجاز فعلی یک مجموعهٔ ذخیره‌شده.',
    '',
    '/schedule ALIAS_OR_JID DATE_TIME MESSAGE',
    'زمان‌بندی پیام. زمان باید Z یا اختلاف ساعت صریح داشته باشد.',
    'مثال: /schedule family 2026-09-23T20:00:00+03:30 جلسه شروع شد.',
    '',
    '/queue',
    'نمایش ۲۰ کار آخر صف. شناسهٔ ابتدای هر خط برای cancel استفاده می‌شود.',
    '',
    '/queue failed',
    'نمایش کارهای ناموفق یا نیازمند بررسی.',
    '',
    '/batch BATCH_ID',
    'نمایش وضعیت کارهای یک ارسال گروهی.',
    '',
    '/cancel JOB_ID',
    'لغو یک پیام ارسال‌نشده با شناسهٔ صف.',
    'مثال: /cancel 550e8400-e29b-41d4-a716-446655440000',
    '',
    'نکته: ارسال از Message Yourself فعلاً فقط پیام متنی را پشتیبانی می‌کند.',
  ].join('\n');
}

export function createControllerExecutor(
  context: AppContext,
  groups: WhatsAppGroupService,
): (command: string) => Promise<string> {
  const bulk = new BulkControllerCommands(context);
  const groupSets = new GroupSetCommands(context);
  return async (command: string): Promise<string> => {
    const trimmed = command.trim();
    const [head, ...rest] = trimmed.split(/\s+/);
    try {
      if (head === '/help') return helpText();
      if (head === '/status') return JSON.stringify(context.health.report(), null, 2);
      if (head === '/queue') return queueLines(context, rest[0] === 'failed');
      if (head === '/groups' && rest[0] === 'refresh') {
        const count = await groups.refresh('self-controller');
        return `${count} گروه به‌روزرسانی شد. گروه‌های جدید تا اجرای /groups allow غیرفعال می‌مانند.\n\nبرای دیدن فهرست: /groups`;
      }
      if (head === '/groups' && rest[0] === 'alias' && rest[1] && rest[2]) {
        const destination = context.destinations.setAlias(rest[1], rest[2], 'self-controller');
        return `نام کوتاه «${destination.alias}» برای گروه «${destination.subject}» ثبت شد.`;
      }
      if (head === '/groups' && rest[0] === 'allow' && rest[1]) {
        const destination = context.destinations.setEnabled(rest[1], true, 'self-controller');
        return `✅ ارسال به گروه «${destination.subject}» مجاز شد.\nمثال: /send ${destination.alias ?? destination.jid} متن پیام`;
      }
      if (head === '/groups' && rest[0] === 'deny' && rest[1]) {
        const destination = context.destinations.setEnabled(rest[1], false, 'self-controller');
        return `⛔ ارسال به گروه «${destination.subject}» غیرفعال شد و پیام‌های ارسال‌نشدهٔ آن لغو شدند.`;
      }
      if (head === '/groups') return groupLines(context);
      if (head === '/groupset') return groupSets.execute(trimmed);
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
      if (head === '/sendmulti') return bulk.sendMulti(trimmed);
      if (head === '/sendall') return bulk.sendAll(trimmed);
      if (head === '/sendset') return bulk.sendSet(trimmed);
      if (head === '/batch' && rest[0]) return bulk.batch(rest[0]);
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
      return `فرمان شناخته نشد. برای دیدن راهنمای کامل /help را بفرستید.\n\n${helpText()}`;
    } catch (error) {
      context.logger.warn({ err: error, controller_command: head }, 'controller_command_failed');
      return '❌ Command failed. Nothing further was queued. Check service logs for details.';
    }
  };
}

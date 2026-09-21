import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createAppContext } from '../app-context.js';
import type { AppConfig } from '../config/schema.js';
import { safeErrorMessage } from '../domain/types.js';

export type CheckSeverity = 'pass' | 'info' | 'warning' | 'fail';

export interface CheckItem {
  id: string;
  severity: CheckSeverity;
  title: string;
  detail: string;
}

export interface CheckReport {
  status: 'healthy' | 'warning' | 'unhealthy';
  healthy: boolean;
  checkedAt: string;
  checks: CheckItem[];
  summary: {
    passed: number;
    info: number;
    warnings: number;
    failed: number;
  };
}

interface LockData {
  pid: number;
  startedAt: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockData | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockData>;
    if (typeof value.pid !== 'number' || typeof value.startedAt !== 'string') return null;
    return { pid: value.pid, startedAt: value.startedAt };
  } catch {
    return null;
  }
}

function buildReport(checks: CheckItem[]): CheckReport {
  const summary = {
    passed: checks.filter((item) => item.severity === 'pass').length,
    info: checks.filter((item) => item.severity === 'info').length,
    warnings: checks.filter((item) => item.severity === 'warning').length,
    failed: checks.filter((item) => item.severity === 'fail').length,
  };
  const status = summary.failed > 0 ? 'unhealthy' : summary.warnings > 0 ? 'warning' : 'healthy';
  return {
    status,
    healthy: status !== 'unhealthy',
    checkedAt: new Date().toISOString(),
    checks,
    summary,
  };
}

export function failedCheckReport(error: unknown): CheckReport {
  return buildReport([
    {
      id: 'configuration',
      severity: 'fail',
      title: 'Configuration',
      detail: safeErrorMessage(error),
    },
  ]);
}

export function runSystemCheck(config: AppConfig): CheckReport {
  const checks: CheckItem[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    severity: nodeMajor >= 20 ? 'pass' : 'fail',
    title: 'Node.js version',
    detail: nodeMajor >= 20 ? `${process.version} is supported.` : `${process.version} is too old; Node.js 20+ is required.`,
  });

  const directories = new Set([
    config.stateDir,
    config.mediaDir,
    dirname(config.databasePath),
    dirname(config.lockPath),
  ]);
  for (const directory of directories) {
    try {
      accessSync(directory, constants.R_OK | constants.W_OK);
      checks.push({
        id: `directory:${directory}`,
        severity: 'pass',
        title: 'Path access',
        detail: `${directory} is readable and writable.`,
      });
    } catch {
      checks.push({
        id: `directory:${directory}`,
        severity: 'fail',
        title: 'Path access',
        detail: `${directory} does not exist or is not readable and writable.`,
      });
    }
  }

  if (existsSync(config.lockPath)) {
    const lock = readLock(config.lockPath);
    if (lock && processIsAlive(lock.pid)) {
      checks.push({
        id: 'daemon-lock',
        severity: 'pass',
        title: 'Daemon',
        detail: `Process PID ${lock.pid} has been active since ${lock.startedAt}.`,
      });
    } else {
      checks.push({
        id: 'daemon-lock',
        severity: 'warning',
        title: 'Daemon',
        detail: 'The lock file exists, but no active process could be confirmed; the lock may be stale.',
      });
    }
  } else {
    checks.push({
      id: 'daemon-lock',
      severity: 'info',
      title: 'Daemon',
      detail: 'The daemon is not running or has no active lock.',
    });
  }

  let context: ReturnType<typeof createAppContext> | undefined;
  try {
    context = createAppContext(config);
    const health = context.health.report();
    checks.push({
      id: 'database',
      severity: health.databaseReachable ? 'pass' : 'fail',
      title: 'SQLite',
      detail: health.databaseReachable ? `The database is reachable; journal=${health.databaseJournalMode}.` : 'The database is not reachable.',
    });
    checks.push({
      id: 'wal',
      severity: health.databaseJournalMode.toLowerCase() === 'wal' ? 'pass' : 'warning',
      title: 'WAL mode',
      detail:
        health.databaseJournalMode.toLowerCase() === 'wal'
          ? 'SQLite is using WAL mode.'
          : `The current journal mode is ${health.databaseJournalMode}; WAL is recommended.`,
    });

    if (health.authState === 'AVAILABLE') {
      checks.push({ id: 'auth', severity: 'pass', title: 'WhatsApp authentication', detail: 'Local credentials are available.' });
    } else if (config.dryRun) {
      checks.push({ id: 'auth', severity: 'info', title: 'WhatsApp authentication', detail: 'Authentication is not required in dry-run mode.' });
    } else {
      checks.push({ id: 'auth', severity: 'fail', title: 'WhatsApp authentication', detail: 'Authentication is required; run `wts auth login`.' });
    }

    const seriousConnection = ['AUTH_REQUIRED', 'LOGGED_OUT', 'FATAL'].includes(health.connectionState);
    checks.push({
      id: 'connection',
      severity: seriousConnection ? 'fail' : health.connectionState === 'CONNECTED' || config.dryRun ? 'pass' : 'warning',
      title: 'Connection',
      detail: `Connection state: ${health.connectionState}`,
    });

    if (health.reviewRequired > 0) {
      checks.push({
        id: 'review-required',
        severity: 'warning',
        title: 'Review-required queue',
        detail: `${health.reviewRequired} job(s) are in REVIEW_REQUIRED; check WhatsApp before retrying.`,
      });
    } else {
      checks.push({ id: 'review-required', severity: 'pass', title: 'Review-required queue', detail: 'No uncertain jobs were found.' });
    }

    if (health.failed > 0) {
      checks.push({ id: 'failed-jobs', severity: 'warning', title: 'Failed jobs', detail: `${health.failed} job(s) are in FAILED.` });
    } else {
      checks.push({ id: 'failed-jobs', severity: 'pass', title: 'Failed jobs', detail: 'No failed jobs were found.' });
    }

    const activeJobs = context.jobs.list({
      statuses: ['PENDING', 'SCHEDULED', 'PROCESSING', 'WAITING_RATE_LIMIT', 'RETRY'],
      limit: 10_000,
    });
    const missingMedia = activeJobs.filter((job) => job.mediaPath && !existsSync(job.mediaPath));
    checks.push({
      id: 'media',
      severity: missingMedia.length > 0 ? 'fail' : 'pass',
      title: 'Queued media',
      detail:
        missingMedia.length > 0
          ? `${missingMedia.length} active job(s) are missing their staged files.`
          : `No missing media files were found among ${activeJobs.length} active job(s).`,
    });

    checks.push({
      id: 'queue-summary',
      severity: 'info',
      title: 'Queue summary',
      detail: `worker=${health.workerState}, oldestPending=${health.oldestPending ?? 'none'}, lastSend=${health.lastSuccessfulSend ?? 'none'}`,
    });
  } catch (error) {
    checks.push({ id: 'database', severity: 'fail', title: 'SQLite', detail: safeErrorMessage(error) });
  } finally {
    context?.close();
  }

  return buildReport(checks);
}

export function formatCheckReport(report: CheckReport): string {
  const symbols: Record<CheckSeverity, string> = {
    pass: '✓',
    info: '•',
    warning: '!',
    fail: '✗',
  };
  const heading =
    report.status === 'healthy'
      ? 'Healthy — no operational issues found'
      : report.status === 'warning'
        ? 'Operational with warnings — review the items below'
        : 'Unhealthy — at least one serious issue was found';
  const lines = [`\nCheck result: ${heading}\n`];
  for (const item of report.checks) {
    lines.push(`${symbols[item.severity]} ${item.title}: ${item.detail}`);
  }
  lines.push(
    `\nSummary: ${report.summary.passed} passed, ${report.summary.info} info, ${report.summary.warnings} warning(s), ${report.summary.failed} failed`,
  );
  return lines.join('\n');
}

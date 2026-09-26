import type { AppConfig } from '../config/schema.js';
import type { Database } from '../db/database.js';
import {
  AuthRepository,
  JobRepository,
  StateRepository,
} from '../db/repositories/index.js';

export interface HealthReport {
  healthy: boolean;
  databaseReachable: boolean;
  databaseJournalMode: string;
  connectionState: string;
  authState: 'AVAILABLE' | 'REQUIRED';
  ownJid: string | null;
  queueCounts: Readonly<Record<string, number>>;
  oldestPending: string | null;
  reviewRequired: number;
  failed: number;
  lastSuccessfulSend: string | null;
  lastConnectionAt: string | null;
  dryRun: boolean;
  workerState: string;
  controllerState: string;
}

export class HealthService {
  public constructor(
    private readonly database: Database,
    private readonly jobs: JobRepository,
    private readonly state: StateRepository,
    private readonly auth: AuthRepository,
    private readonly config: AppConfig,
  ) {}

  public report(): HealthReport {
    const counts = this.jobs.counts();
    const connectionState = this.state.get('connectivity') ?? 'DISCONNECTED';
    const authAvailable = this.auth.hasCredentials();
    const serious = ['AUTH_REQUIRED', 'LOGGED_OUT', 'FATAL'].includes(connectionState);
    return {
      healthy: !serious && (authAvailable || this.config.dryRun),
      databaseReachable: true,
      databaseJournalMode: this.database.getJournalMode(),
      connectionState,
      authState: authAvailable ? 'AVAILABLE' : 'REQUIRED',
      ownJid: this.state.get('own_jid'),
      queueCounts: counts,
      oldestPending: this.jobs.oldestPending(),
      reviewRequired: counts.REVIEW_REQUIRED ?? 0,
      failed: counts.FAILED ?? 0,
      lastSuccessfulSend: this.jobs.lastSuccessfulSend(),
      lastConnectionAt: this.state.get('last_connection_at'),
      dryRun: this.config.dryRun,
      workerState: this.state.get('worker_state') ?? 'STOPPED',
      // DISABLED = feature off, DETACHED = enabled without a live socket,
      // ATTACHED = listening on the current socket. Reported but not folded
      // into `healthy`: outbound delivery is unaffected by a deaf controller.
      controllerState: this.state.get('controller_state') ?? 'DISABLED',
    };
  }
}

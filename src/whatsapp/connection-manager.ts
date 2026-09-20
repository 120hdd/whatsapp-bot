import { setTimeout as sleep } from 'node:timers/promises';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  type ConnectionState,
  type UserFacingSocketConfig,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/schema.js';
import {
  AuditRepository,
  AuthRepository,
  StateRepository,
} from '../db/repositories/index.js';
import { retryDelayMs } from '../messaging/retry-policy.js';
import { useSQLiteAuthState } from './auth-state.js';
import { normalizeJid } from './jid.js';

export const CONNECTION_STATES = [
  'CONNECTING',
  'CONNECTED',
  'DISCONNECTED',
  'RECONNECTING',
  'AUTH_REQUIRED',
  'LOGGED_OUT',
  'FATAL',
] as const;

export type ManagedConnectionState = (typeof CONNECTION_STATES)[number];
export type SocketFactory = (config: UserFacingSocketConfig) => WASocket;

export interface ConnectOptions {
  pairingPhone?: string;
  onQr?: (qr: string) => void;
  onPairingCode?: (code: string) => void;
  autoReconnect?: boolean;
}

function disconnectStatus(update: Partial<ConnectionState>): number | null {
  const error = update.lastDisconnect?.error;
  if (!error || typeof error !== 'object') return null;
  const shaped = error as { output?: { statusCode?: number }; statusCode?: number };
  return shaped.output?.statusCode ?? shaped.statusCode ?? null;
}

export class ConnectionManager {
  private socket: WASocket | null = null;
  private stateValue: ManagedConnectionState = 'DISCONNECTED';
  private connectPromise: Promise<void> | null = null;
  private generation = 0;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastOptions: ConnectOptions = {};

  public constructor(
    private readonly authRepository: AuthRepository,
    private readonly stateRepository: StateRepository,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly socketFactory: SocketFactory = makeWASocket,
  ) {}

  public get state(): ManagedConnectionState {
    return this.stateValue;
  }

  public get currentSocket(): WASocket | null {
    return this.socket;
  }

  public async connect(options: ConnectOptions = {}): Promise<void> {
    if (this.stateValue === 'CONNECTED' && this.socket) return;
    if (this.connectPromise) return this.connectPromise;
    this.stopped = false;
    this.lastOptions = options;
    this.connectPromise = this.createSocket(options).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  public async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    if (socket) {
      await socket.end(undefined);
      // Let already-queued Baileys auth/LID handlers drain before the CLI
      // closes the SQLite context that backs the auth state.
      await sleep(100);
    }
    this.setState('DISCONNECTED');
  }

  public async logout(): Promise<void> {
    this.stopped = true;
    if (this.socket) {
      await this.socket.logout();
      void this.socket.end(undefined);
    }
    this.socket = null;
    this.authRepository.clear();
    this.stateRepository.remove('own_jid');
    this.stateRepository.remove('own_lid');
    this.stateRepository.set('outgoing_pause_reason', 'AUTH_REQUIRED');
    this.setState('LOGGED_OUT');
    this.audit.add('auth_logout', { actor: 'cli' });
  }

  private async createSocket(options: ConnectOptions, protocolRestartCount = 0): Promise<void> {
    const generation = ++this.generation;
    this.setState(this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING');
    const { state, saveCreds } = await useSQLiteAuthState(this.authRepository);
    const socket = this.socketFactory({
      auth: state,
      browser: Browsers.ubuntu('SajadBot WhatsApp'),
      logger: this.logger.child({ component: 'baileys' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.socket = socket;
    socket.ev.on('creds.update', () => {
      void saveCreds().catch((error: unknown) => {
        this.logger.error({ err: error }, 'auth_credentials_persist_failed');
      });
    });

    const connected = new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.ev.on('connection.update', (update) => {
        if (generation !== this.generation) return;
        if (update.qr) options.onQr?.(update.qr);
        if (update.connection === 'open') {
          settled = true;
          this.reconnectAttempt = 0;
          this.setState('CONNECTED');
          const ownJid = socket.user?.id;
          const ownLid = socket.user?.lid;
          if (ownJid) this.stateRepository.set('own_jid', normalizeJid(ownJid));
          if (ownLid) this.stateRepository.set('own_lid', normalizeJid(ownLid));
          this.stateRepository.set('last_connection_at', new Date().toISOString());
          this.stateRepository.remove('outgoing_pause_reason');
          this.stateRepository.remove('outgoing_pause_until');
          this.audit.add('connection_restored', { actor: 'daemon' });
          this.logger.info({ connection_state: 'CONNECTED' }, 'whatsapp_connected');
          resolve();
        }
        if (update.connection === 'close') {
          const status = disconnectStatus(update);
          const restartRequired = status === DisconnectReason.restartRequired;
          const loggedOut = status === DisconnectReason.loggedOut;
          const fatal =
            status === DisconnectReason.badSession ||
            status === DisconnectReason.multideviceMismatch ||
            status === DisconnectReason.forbidden;
          this.socket = null;
          if (restartRequired && !settled && !this.stopped && protocolRestartCount < 2) {
            settled = true;
            this.setState('RECONNECTING');
            this.logger.info(
              { connection_state: 'RECONNECTING', protocol_restart: protocolRestartCount + 1 },
              'whatsapp_protocol_restart_required',
            );
            void (async () => {
              try {
                // Pairing mutates the in-memory credentials immediately before WhatsApp
                // closes the stream with 515. Flush that state before constructing the
                // replacement socket, even if the final creds.update event is delayed.
                await saveCreds();
                await sleep(250);
                if (this.stopped) throw new Error('WhatsApp connection stopped during protocol restart');
                await this.createSocket(options, protocolRestartCount + 1);
                resolve();
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            })();
            return;
          }
          if (loggedOut) {
            this.setState('LOGGED_OUT');
            this.stateRepository.set('outgoing_pause_reason', 'LOGGED_OUT');
            this.audit.add('auth_required', { actor: 'connection', details: { reason: 'logged_out' } });
          } else if (fatal) {
            this.setState('FATAL');
            this.stateRepository.set('outgoing_pause_reason', 'FATAL');
            this.audit.add('connection_fatal', { actor: 'connection', details: { status } });
          } else {
            this.setState('DISCONNECTED');
            if (!this.stopped && options.autoReconnect !== false) this.scheduleReconnect();
          }
          if (!settled) {
            settled = true;
            reject(new Error(`WhatsApp connection closed before ready (status ${status ?? 'unknown'})`));
          }
        }
      });
    });

    if (!state.creds.registered && options.pairingPhone) {
      const phone = options.pairingPhone.replace(/\D/g, '');
      if (!phone) throw new Error('Pairing phone must include country code and digits');
      const code = await socket.requestPairingCode(phone);
      options.onPairingCode?.(code);
    }
    await connected;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectAttempt += 1;
    const delay = retryDelayMs(
      this.reconnectAttempt,
      this.config.retryBaseMs,
      this.config.retryMaxMs,
    );
    this.setState('RECONNECTING');
    this.logger.warn(
      { connection_state: 'RECONNECTING', attempt: this.reconnectAttempt, delay_ms: delay },
      'whatsapp_reconnect_scheduled',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(this.lastOptions).catch(async (error: unknown) => {
        this.logger.warn({ err: error }, 'whatsapp_reconnect_failed');
        await sleep(0);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private setState(state: ManagedConnectionState): void {
    this.stateValue = state;
    this.stateRepository.set('connectivity', state);
  }
}

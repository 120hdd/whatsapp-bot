import pino, { type Logger } from 'pino';

import type { AppConfig } from '../config/schema.js';

const redactPaths = [
  'credentials',
  'creds',
  'authState',
  'state.creds',
  'signalKeys',
  'privateKey',
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'advSecretKey',
  'me.lid',
  'token',
  'password',
];

export function createLogger(config: Pick<AppConfig, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'sajadbot-whatsapp' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

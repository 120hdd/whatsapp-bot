import { z } from 'zod';

const booleanFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['true', '1', 'yes'].includes(value),
  );

const pathValue = z.string().trim().min(1);

export const configSchema = z.object({
  databasePath: pathValue,
  stateDir: pathValue,
  mediaDir: pathValue,
  lockPath: pathValue,
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  timezone: z.string().trim().min(1),
  dryRun: booleanFromEnv,
  workerPollMs: z.coerce.number().int().min(50).max(60_000),
  sendIntervalMs: z.coerce.number().int().min(0).max(3_600_000),
  maxAttempts: z.coerce.number().int().min(1).max(100),
  retryBaseMs: z.coerce.number().int().min(100).max(3_600_000),
  retryMaxMs: z.coerce.number().int().min(100).max(86_400_000),
  maxMediaBytes: z.coerce.number().int().positive(),
  selfControllerEnabled: booleanFromEnv,
  pairingPhone: z.string().trim().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

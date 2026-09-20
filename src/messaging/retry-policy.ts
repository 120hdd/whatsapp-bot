import type { DeliveryErrorClass } from '../domain/errors.js';

export interface RetryDecision {
  action: 'retry' | 'rate-limit' | 'fail' | 'pause-auth';
  delayMs: number | null;
}

const transientClasses = new Set<DeliveryErrorClass>([
  'TEMPORARY_NETWORK',
  'CONNECTION_CLOSED',
  'SESSION_ERROR',
  'UNKNOWN_TRANSIENT',
]);

export function retryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.max(100, Math.round(exponential * jitter));
}

export function decideRetry(options: {
  errorClass: DeliveryErrorClass;
  attempt: number;
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  retryAfterMs?: number;
  random?: () => number;
}): RetryDecision {
  if (options.errorClass === 'AUTH_REQUIRED' || options.errorClass === 'LOGGED_OUT') {
    return {
      action: 'pause-auth',
      delayMs: retryDelayMs(
        options.attempt,
        options.baseMs,
        options.maxMs,
        options.random,
      ),
    };
  }
  if (options.attempt >= options.maxAttempts) return { action: 'fail', delayMs: null };
  if (options.errorClass === 'RATE_LIMITED') {
    return {
      action: 'rate-limit',
      delayMs:
        options.retryAfterMs ??
        retryDelayMs(options.attempt, options.baseMs, options.maxMs, options.random),
    };
  }
  if (transientClasses.has(options.errorClass)) {
    return {
      action: 'retry',
      delayMs: retryDelayMs(
        options.attempt,
        options.baseMs,
        options.maxMs,
        options.random,
      ),
    };
  }
  return { action: 'fail', delayMs: null };
}

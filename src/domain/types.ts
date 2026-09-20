export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function toUtcIso(date: Date): string {
  return date.toISOString();
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}

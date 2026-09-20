export const ERROR_CLASSES = [
  'TEMPORARY_NETWORK',
  'CONNECTION_CLOSED',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'LOGGED_OUT',
  'PERMISSION_ERROR',
  'DESTINATION_ERROR',
  'INVALID_PAYLOAD',
  'MEDIA_ERROR',
  'SESSION_ERROR',
  'UNKNOWN_TRANSIENT',
  'UNKNOWN_PERMANENT',
] as const;

export type DeliveryErrorClass = (typeof ERROR_CLASSES)[number];

export class DeliveryError extends Error {
  public readonly errorClass: DeliveryErrorClass;
  public readonly retryAfterMs: number | undefined;
  public readonly causeValue: unknown;

  public constructor(
    errorClass: DeliveryErrorClass,
    safeMessage: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(safeMessage);
    this.name = 'DeliveryError';
    this.errorClass = errorClass;
    this.retryAfterMs = options.retryAfterMs;
    this.causeValue = options.cause;
  }
}

export class NotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class DuplicateJobError extends Error {
  public constructor(public readonly existingId: string) {
    super(`Duplicate job suppressed; existing job: ${existingId}`);
    this.name = 'DuplicateJobError';
  }
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

import { DeliveryError } from '../domain/errors.js';

interface StatusLike {
  output?: { statusCode?: number };
  data?: { statusCode?: number };
  statusCode?: number;
  code?: string | number;
  message?: string;
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as StatusLike;
  return value.output?.statusCode ?? value.data?.statusCode ?? value.statusCode ?? null;
}

export function classifyWhatsAppError(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const value = (error && typeof error === 'object' ? error : {}) as StatusLike;
  const status = statusOf(error);
  const code = String(value.code ?? '');
  const message = value.message?.toLowerCase() ?? '';
  if (status === 401 || message.includes('logged out')) {
    return new DeliveryError('LOGGED_OUT', 'WhatsApp linked-device authorization was revoked', {
      cause: error,
    });
  }
  if (status === 403 || message.includes('not-authorized') || message.includes('forbidden')) {
    return new DeliveryError('PERMISSION_ERROR', 'The account cannot send to this destination', {
      cause: error,
    });
  }
  if (status === 404 || message.includes('not found') || message.includes('no participants')) {
    return new DeliveryError('DESTINATION_ERROR', 'The WhatsApp destination is unavailable', {
      cause: error,
    });
  }
  if (status === 429 || message.includes('rate limit')) {
    return new DeliveryError('RATE_LIMITED', 'WhatsApp temporarily rate-limited delivery', {
      retryAfterMs: 60_000,
      cause: error,
    });
  }
  if (
    [408, 428, 500, 502, 503, 504].includes(status ?? 0) ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)
  ) {
    return new DeliveryError('TEMPORARY_NETWORK', 'A temporary network error interrupted delivery', {
      cause: error,
    });
  }
  if (message.includes('connection closed') || message.includes('socket closed')) {
    return new DeliveryError('CONNECTION_CLOSED', 'The WhatsApp connection closed during delivery', {
      cause: error,
    });
  }
  if (message.includes('media') || message.includes('file')) {
    return new DeliveryError('MEDIA_ERROR', 'WhatsApp rejected the staged media', { cause: error });
  }
  return new DeliveryError('UNKNOWN_TRANSIENT', 'Unexpected error while communicating with WhatsApp', {
    cause: error,
  });
}

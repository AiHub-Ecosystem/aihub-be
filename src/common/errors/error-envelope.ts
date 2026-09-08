import type { ErrorCode } from './error-code';

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly request_id: string;
  readonly retryable: boolean;
  readonly retry_after_ms?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ErrorEnvelope {
  readonly error: ErrorPayload;
}

export interface ErrorEnvelopeOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

function withoutLegacyRetryHint(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (details === undefined) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(details).filter(([key]) => key !== 'retry_after_ms'),
  );

  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function validRetryAfterMs(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function createErrorEnvelope(
  options: ErrorEnvelopeOptions,
): ErrorEnvelope {
  const details = withoutLegacyRetryHint(options.details);
  const retryAfterMs = validRetryAfterMs(options.retryAfterMs);

  return {
    error: {
      code: options.code,
      message: options.message,
      request_id: options.requestId,
      retryable: options.retryable,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function createInternalErrorEnvelope(requestId: string): ErrorEnvelope {
  return createErrorEnvelope({
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
    requestId,
    retryable: false,
  });
}

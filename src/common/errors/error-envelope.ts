import type { ErrorCode } from './error-code';

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly request_id: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ErrorEnvelope {
  readonly error: ErrorPayload;
}

export function createInternalErrorEnvelope(requestId: string): ErrorEnvelope {
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      request_id: requestId,
    },
  };
}

import type { ErrorCode } from './error-code';
import {
  type ErrorEnvelope,
  createErrorEnvelope,
  createInternalErrorEnvelope,
} from './error-envelope';

export interface AppErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly downstreamStatus?: number;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly downstreamStatus?: number;

  constructor(options: AppErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable;

    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }

    if (options.downstreamStatus !== undefined) {
      this.downstreamStatus = options.downstreamStatus;
    }

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return createErrorEnvelope({
      code: this.code,
      message: this.message,
      requestId,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: this.retryAfterMs }),
      ...(this.details === undefined ? {} : { details: this.details }),
    });
  }

  static toEnvelope(error: unknown, requestId: string): ErrorEnvelope {
    if (error instanceof AppError) {
      return error.toEnvelope(requestId);
    }

    return createInternalErrorEnvelope(requestId);
  }
}

import type { ErrorCode } from './error-code';
import {
  type ErrorEnvelope,
  createErrorEnvelope,
  createInternalErrorEnvelope,
} from './error-envelope';
import { type HttpStatus, httpStatusForErrorCode } from './error-registry';

export interface AppErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly downstreamStatus?: number;
  readonly cause?: unknown;
  /**
   * What an operator needs to find the fault, written for the log and never
   * for the client: it is not part of the envelope. It may name fields and
   * kinds of mismatch and must never contain a value from a request or a
   * downstream response. Unlike `cause`, which can carry anything and is never
   * logged, this is vetted by whoever sets it.
   */
  readonly diagnostic?: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: HttpStatus;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly downstreamStatus?: number;
  readonly diagnostic?: string;

  constructor(options: AppErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.code = options.code;
    this.httpStatus = httpStatusForErrorCode(options.code);
    this.retryable = options.retryable;

    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }

    if (options.downstreamStatus !== undefined) {
      this.downstreamStatus = options.downstreamStatus;
    }

    if (options.diagnostic !== undefined) {
      this.diagnostic = options.diagnostic;
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

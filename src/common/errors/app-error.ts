import type { ErrorCode } from './error-code';
import type { ErrorEnvelope, ErrorPayload } from './error-envelope';

export interface AppErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly downstreamStatus?: number;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
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

    if (options.downstreamStatus !== undefined) {
      this.downstreamStatus = options.downstreamStatus;
    }

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    const payload: ErrorPayload =
      this.details === undefined
        ? {
            code: this.code,
            message: this.message,
            request_id: requestId,
          }
        : {
            code: this.code,
            message: this.message,
            request_id: requestId,
            details: this.details,
          };

    return { error: payload };
  }

  static toEnvelope(error: unknown, requestId: string): ErrorEnvelope {
    if (error instanceof AppError) {
      return error.toEnvelope(requestId);
    }

    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        request_id: requestId,
      },
    };
  }
}

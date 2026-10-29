import { AppError } from '@/common/errors/app-error';
import type { ErrorCode } from '@/common/errors/error-code';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';
import {
  type ObjectStorageFailureReason,
  recordObjectStorageFailure,
} from '@/common/observability/metrics';

export function objectStorageNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    name === 'NotFound' ||
    (typeof $metadata === 'object' &&
      $metadata !== null &&
      'httpStatusCode' in $metadata &&
      ($metadata as { httpStatusCode?: unknown }).httpStatusCode === 404)
  );
}

/** Request callers supply their shared deadline; sweeps allow 30s per operation, including body reads. */
export function objectStorageSignal(): AbortSignal {
  return AbortSignal.timeout(30_000);
}

function failureReason(
  error: unknown,
  signal?: AbortSignal,
): ObjectStorageFailureReason {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    return typeof reason === 'object' &&
      reason !== null &&
      'name' in reason &&
      reason.name === 'TimeoutError'
      ? 'deadline'
      : 'cancelled';
  }
  if (typeof error !== 'object' || error === null) return 'unavailable';
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  // The SDK can wrap a transport error without copying its code.
  if (
    ('code' in error && error.code === 'ECONNREFUSED') ||
    message.includes('ECONNREFUSED')
  )
    return 'connection_refused';
  if ('name' in error && error.name === 'TimeoutError') {
    if (message.includes('did not establish a connection'))
      return 'connection_timeout';
    if (message.includes('requestTimeout')) return 'request_timeout';
  }
  return 'unavailable';
}

export function objectStorageUnavailable(
  code: Extract<
    ErrorCode,
    | 'AVATAR_STORAGE_UNAVAILABLE'
    | 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE'
    | 'WRITING_CHART_STORAGE_UNAVAILABLE'
  >,
  message: string,
  cause?: unknown,
  signal?: AbortSignal,
): AppError {
  const reason = failureReason(cause, signal);
  if (cause !== undefined) recordObjectStorageFailure(reason);
  return new AppError({
    code,
    message,
    retryable: true,
    retryAfterMs: outageRetryAfterMs(),
    diagnostic: `object_storage:${reason}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

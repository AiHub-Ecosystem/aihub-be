import { AppError } from '@/common/errors/app-error';
import type { ErrorCode } from '@/common/errors/error-code';

export function payloadTooLarge(
  code: ErrorCode,
  message: string,
  retryable = false,
): AppError {
  return new AppError({ code, message, retryable });
}

export function uploadNotFound(
  code: ErrorCode,
  message: string,
  retryable = false,
): AppError {
  return new AppError({ code, message, retryable });
}

export function storageUnavailable(
  code: ErrorCode,
  message: string,
  cause?: unknown,
  signal?: AbortSignal,
  retryable = true,
): AppError {
  return new AppError({
    code,
    message,
    retryable,
    ...(cause === undefined ? {} : { cause }),
    ...(signal === undefined ? {} : {}),
  });
}

export function storeUnavailable(
  code: ErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): AppError {
  return new AppError({
    code,
    message,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}

import { AppError } from '../../../common/errors/app-error';

function invalidIdempotencyKey(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Idempotency-Key must be between 1 and 255 UTF-8 bytes',
    httpStatus: 400,
    retryable: false,
  });
}

export function requireIdempotencyKey(
  header: string | readonly string[] | undefined,
): string {
  if (typeof header !== 'string') {
    throw invalidIdempotencyKey();
  }

  const normalized = header.trim();
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes < 1 || bytes > 255) {
    throw invalidIdempotencyKey();
  }
  return normalized;
}

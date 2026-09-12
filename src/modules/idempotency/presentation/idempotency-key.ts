import {
  type IdempotencyMode,
  OPERATION_CATALOG,
} from '../../../catalog/operation-catalog';
import type { OperationId } from '../../../catalog/operation-id';
import { AppError } from '../../../common/errors/app-error';

function invalidIdempotencyKey(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Idempotency-Key must be between 1 and 255 UTF-8 bytes',
    retryable: false,
  });
}

function isOptionalIdempotency(mode: IdempotencyMode): boolean {
  return mode === 'optional';
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

export function resolveIdempotencyKey(
  operation: OperationId,
  header: string | readonly string[] | undefined,
): string | undefined {
  const mode: IdempotencyMode = OPERATION_CATALOG[operation].idempotency;
  if (
    mode === 'none' ||
    (isOptionalIdempotency(mode) && header === undefined)
  ) {
    return undefined;
  }
  return requireIdempotencyKey(header);
}

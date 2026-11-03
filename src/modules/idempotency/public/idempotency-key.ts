import { resolveIdempotencyKey as resolveApplicationIdempotencyKey } from '@/modules/idempotency/application/idempotency-key';
import type { IdempotencyOperation } from './idempotency-operation';

export function resolveIdempotencyKey(
  operation: IdempotencyOperation,
  header: string | readonly string[] | undefined,
): string | undefined {
  return resolveApplicationIdempotencyKey(operation, header);
}

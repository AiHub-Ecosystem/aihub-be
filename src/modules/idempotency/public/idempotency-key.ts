import { resolveIdempotencyKey as resolveApplicationIdempotencyKey } from '@/modules/idempotency/application/idempotency-key';
import type { IdempotencyOperation } from './idempotency-operation';

export { IDEMPOTENCY_RETENTION_MS } from '@/modules/idempotency/application/idempotency-service';

export function resolveIdempotencyKey(
  operation: IdempotencyOperation,
  header: string | readonly string[] | undefined,
): string | undefined {
  return resolveApplicationIdempotencyKey(operation, header);
}

import { createHash } from 'node:crypto';

import { canonicalJson } from '@/common/serialization/canonical-json';
import type { IdempotencyOperation } from './idempotency-operation';

export interface IdempotencyFingerprintInput {
  readonly organizationId: string | null;
  readonly operation: IdempotencyOperation;
  readonly actorId: string;
  readonly requestBody: unknown;
}

export function createIdempotencyFingerprint(
  input: IdempotencyFingerprintInput,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        organization_id: input.organizationId,
        operation: input.operation,
        actor_id: input.actorId,
        request: input.requestBody,
      }),
    )
    .digest('hex');
}

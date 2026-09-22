import { createHash } from 'node:crypto';

import type { IdempotencyOperation } from './idempotency-operation';

export interface IdempotencyFingerprintInput {
  readonly organizationId: string;
  readonly operation: IdempotencyOperation;
  readonly actorId: string;
  readonly requestBody: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        'idempotency fingerprint cannot contain a non-finite number',
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) {
        throw new Error('idempotency fingerprint cannot contain undefined');
      }
      normalized[key] = canonicalize(item);
    }
    return normalized;
  }

  throw new Error('idempotency fingerprint contains an unsupported value');
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new Error('idempotency fingerprint could not be serialized');
  }
  return serialized;
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

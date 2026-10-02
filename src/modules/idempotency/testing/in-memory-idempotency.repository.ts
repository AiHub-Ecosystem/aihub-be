import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
  IdempotencyReservation,
  ReserveIdempotencyInput,
} from '@/modules/idempotency/application/idempotency-repository.port';

interface StoredIdempotencyRecord {
  fingerprintHex: string;
  requestId: string;
  state: 'pending' | 'completed' | 'failed';
  responseBody?: unknown;
}

/**
 * A test double for the durable idempotency store, shared by the HTTP specs
 * that need a real request to run the full chain without a database.
 */
export class InMemoryIdempotencyRepository
  implements IdempotencyRepositoryPort
{
  private readonly records = new Map<string, StoredIdempotencyRecord>();

  reserve(input: ReserveIdempotencyInput): Promise<IdempotencyReservation> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, {
        fingerprintHex: input.fingerprintHex,
        requestId: input.requestId,
        state: 'pending',
      });
      return Promise.resolve({ kind: 'claimed', requestId: input.requestId });
    }
    if (existing.fingerprintHex !== input.fingerprintHex) {
      return Promise.resolve({ kind: 'conflict', reason: 'fingerprint' });
    }
    if (existing.state === 'pending') {
      return Promise.resolve({ kind: 'conflict', reason: 'pending' });
    }
    if (existing.state === 'failed') {
      existing.state = 'pending';
      existing.requestId = input.requestId;
      existing.responseBody = undefined;
      return Promise.resolve({ kind: 'claimed', requestId: input.requestId });
    }
    return Promise.resolve({
      kind: 'replay',
      responseStatus: 200,
      responseBody: existing.responseBody,
    });
  }

  complete(input: CompleteIdempotencyInput): Promise<void> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (
      existing?.state === 'pending' &&
      existing.requestId === input.requestId
    ) {
      existing.state = 'completed';
      existing.responseBody = input.responseBody;
    }
    return Promise.resolve();
  }

  markFailed(input: IdempotencyAttemptInput): Promise<void> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (
      existing?.state === 'pending' &&
      existing.requestId === input.requestId
    ) {
      existing.state = 'failed';
    }
    return Promise.resolve();
  }

  delete(input: IdempotencyAttemptInput): Promise<void> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (
      existing?.state === 'pending' &&
      existing.requestId === input.requestId
    ) {
      this.records.delete(key);
    }
    return Promise.resolve();
  }

  cleanupExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

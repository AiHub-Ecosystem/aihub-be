import type { IdempotencyOperation } from './idempotency-operation';

export interface ReserveIdempotencyInput {
  readonly organizationId: string;
  readonly operation: IdempotencyOperation;
  readonly actorScope?: string;
  readonly idempotencyKey: string;
  readonly fingerprintHex: string;
  readonly requestId: string;
  readonly expiresAt: Date;
}

export type IdempotencyReservation =
  | { readonly kind: 'claimed'; readonly requestId: string }
  | {
      readonly kind: 'replay';
      readonly responseStatus: number;
      readonly responseBody: unknown;
    }
  | { readonly kind: 'conflict'; readonly reason: 'fingerprint' | 'pending' };

export interface CompleteIdempotencyInput {
  readonly organizationId: string;
  readonly operation: IdempotencyOperation;
  readonly actorScope?: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

export interface IdempotencyAttemptInput {
  readonly organizationId: string;
  readonly operation: IdempotencyOperation;
  readonly actorScope?: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface IdempotencyRepositoryPort {
  reserve(input: ReserveIdempotencyInput): Promise<IdempotencyReservation>;
  complete(input: CompleteIdempotencyInput): Promise<void>;
  markFailed(input: IdempotencyAttemptInput): Promise<void>;
  delete(input: IdempotencyAttemptInput): Promise<void>;
  cleanupExpired(): Promise<number>;
}

export const IDEMPOTENCY_REPOSITORY = Symbol('IDEMPOTENCY_REPOSITORY');

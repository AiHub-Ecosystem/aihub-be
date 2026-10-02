import { AppError } from '@/common/errors/app-error';
import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
  IdempotencyReservation,
  ReserveIdempotencyInput,
} from '@/modules/idempotency/application/idempotency-repository.port';
import type { PostgresIdempotencyClient } from './postgres-idempotency.client';

/**
 * The Organization predicate serves an Organization-scoped key and an Account
 * Idempotency Scope, whose Organization is null, in one statement. It is spelt
 * as an `OR` rather than `IS NOT DISTINCT FROM` because the driver plans each
 * call with its parameters bound, and the planner folds this form to either
 * `= $1` or `IS NULL`, both index conditions; `IS NOT DISTINCT FROM` is only
 * ever a filter over every Organization's rows for the key.
 */
const ORGANIZATION_MATCHES =
  '(organization_id = $1 OR ($1::text IS NULL AND organization_id IS NULL))';

const INSERT_SQL = `
  INSERT INTO idempotency_records (
    organization_id,
    operation,
    actor_scope,
    idempotency_key,
    request_fingerprint,
    state,
    request_id,
    expires_at
  )
  VALUES ($1, $2, $3, $4, decode($5, 'hex'), 'pending', $6, $7)
  ON CONFLICT (organization_id, operation, actor_scope, idempotency_key) DO NOTHING
  RETURNING request_id
`;

const CLAIM_SQL = `
  UPDATE idempotency_records
  SET request_fingerprint = decode($5, 'hex'),
      state = 'pending',
      request_id = $6,
      response_status = NULL,
      response_body = NULL,
      created_at = now(),
      completed_at = NULL,
      expires_at = $7
  WHERE ${ORGANIZATION_MATCHES}
    AND operation = $2
    AND actor_scope = $3
    AND idempotency_key = $4
    AND (
      expires_at <= now()
      OR (state = 'failed' AND request_fingerprint = decode($5, 'hex'))
    )
  RETURNING request_id
`;

const SELECT_SQL = `
  SELECT
    encode(request_fingerprint, 'hex') AS request_fingerprint,
    state,
    request_id,
    response_status,
    response_body
  FROM idempotency_records
  WHERE ${ORGANIZATION_MATCHES}
    AND operation = $2
    AND actor_scope = $3
    AND idempotency_key = $4
  LIMIT 1
`;

const COMPLETE_SQL = `
  UPDATE idempotency_records
  SET state = 'completed',
      response_status = $6,
      response_body = $7,
      completed_at = now()
  WHERE ${ORGANIZATION_MATCHES}
    AND operation = $2
    AND actor_scope = $3
    AND idempotency_key = $4
    AND request_id = $5
    AND state = 'pending'
  RETURNING request_id
`;

const FAILED_SQL = `
  UPDATE idempotency_records
  SET state = 'failed',
      response_status = NULL,
      response_body = NULL,
      completed_at = NULL
  WHERE ${ORGANIZATION_MATCHES}
    AND operation = $2
    AND actor_scope = $3
    AND idempotency_key = $4
    AND request_id = $5
    AND state = 'pending'
  RETURNING request_id
`;

const DELETE_SQL = `
  DELETE FROM idempotency_records
  WHERE ${ORGANIZATION_MATCHES}
    AND operation = $2
    AND actor_scope = $3
    AND idempotency_key = $4
    AND request_id = $5
    AND state = 'pending'
  RETURNING request_id
`;

const CLEANUP_SQL = `
  DELETE FROM idempotency_records
  WHERE expires_at <= now()
  RETURNING request_id
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repositoryError(message: string, cause?: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function requestIdFrom(row: unknown): string {
  if (
    !isRecord(row) ||
    typeof row.request_id !== 'string' ||
    row.request_id.length === 0
  ) {
    throw repositoryError('Idempotency record is malformed');
  }
  return row.request_id;
}

function requireMutationResult(
  rows: readonly unknown[],
  message: string,
): void {
  if (rows.length === 0) {
    throw repositoryError(message);
  }
  requestIdFrom(rows[0]);
}

function reservationFromRow(row: unknown): IdempotencyReservation {
  if (!isRecord(row)) {
    throw repositoryError('Idempotency record is malformed');
  }

  if (
    typeof row.request_id !== 'string' ||
    row.request_id.length === 0 ||
    !('response_status' in row) ||
    !('response_body' in row)
  ) {
    throw repositoryError('Idempotency record is malformed');
  }

  const state = row.state;
  if (state === 'pending') {
    if (row.response_status !== null || row.response_body !== null) {
      throw repositoryError('Idempotency record is malformed');
    }
    return { kind: 'conflict', reason: 'pending' };
  }
  if (state === 'failed') {
    if (row.response_status !== null || row.response_body !== null) {
      throw repositoryError('Idempotency record is malformed');
    }
    return { kind: 'conflict', reason: 'pending' };
  }
  if (
    state !== 'completed' ||
    typeof row.response_status !== 'number' ||
    !Number.isInteger(row.response_status) ||
    row.response_body === null
  ) {
    throw repositoryError('Idempotency record is malformed');
  }
  return {
    kind: 'replay',
    responseStatus: row.response_status,
    responseBody: row.response_body,
  };
}

export class PostgresIdempotencyRepository
  implements IdempotencyRepositoryPort
{
  constructor(private readonly client: PostgresIdempotencyClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }

  async reserve(
    input: ReserveIdempotencyInput,
  ): Promise<IdempotencyReservation> {
    const inserted = await this.client.query(INSERT_SQL, [
      input.organizationId,
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
      input.fingerprintHex,
      input.requestId,
      input.expiresAt,
    ]);
    const insertedRow = inserted[0];
    if (insertedRow !== undefined) {
      return { kind: 'claimed', requestId: requestIdFrom(insertedRow) };
    }

    const claimed = await this.client.query(CLAIM_SQL, [
      input.organizationId,
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
      input.fingerprintHex,
      input.requestId,
      input.expiresAt,
    ]);
    const claimedRow = claimed[0];
    if (claimedRow !== undefined) {
      return { kind: 'claimed', requestId: requestIdFrom(claimedRow) };
    }

    const existing = await this.client.query(SELECT_SQL, [
      input.organizationId,
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
    ]);
    const existingRow = existing[0];
    if (existingRow === undefined) {
      throw repositoryError(
        'Idempotency record disappeared during reservation',
      );
    }
    if (!isRecord(existingRow)) {
      throw repositoryError('Idempotency record is malformed');
    }
    if (typeof existingRow.request_fingerprint !== 'string') {
      throw repositoryError('Idempotency record is malformed');
    }
    if (existingRow.request_fingerprint !== input.fingerprintHex) {
      return { kind: 'conflict', reason: 'fingerprint' };
    }
    return reservationFromRow(existingRow);
  }

  async complete(input: CompleteIdempotencyInput): Promise<void> {
    const rows = await this.client.query(COMPLETE_SQL, [
      input.organizationId,
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
      input.requestId,
      input.responseStatus,
      input.responseBody,
    ]);
    requireMutationResult(rows, 'Idempotency record was not completed');
  }

  async markFailed(input: IdempotencyAttemptInput): Promise<void> {
    const rows = await this.client.query(FAILED_SQL, [
      input.organizationId,
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
      input.requestId,
    ]);
    requireMutationResult(rows, 'Idempotency record was not marked failed');
  }

  async delete(input: IdempotencyAttemptInput): Promise<void> {
    const rows = await this.client.query(DELETE_SQL, [
      input.organizationId,
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
      input.requestId,
    ]);
    requireMutationResult(rows, 'Idempotency record was not deleted');
  }

  async cleanupExpired(): Promise<number> {
    const rows = await this.client.query(CLEANUP_SQL, []);
    return rows.length;
  }
}

import { AppError } from '../../../common/errors/app-error';
import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
  IdempotencyReservation,
  ReserveIdempotencyInput,
} from '../application/idempotency-repository.port';
import type { PostgresIdempotencyClient } from './postgres-idempotency.client';

const INSERT_SQL = `
  INSERT INTO idempotency_records (
    organization_id,
    operation,
    idempotency_key,
    request_fingerprint,
    state,
    request_id,
    expires_at
  )
  VALUES ($1, $2, $3, decode($4, 'hex'), 'pending', $5, $6)
  ON CONFLICT (organization_id, operation, idempotency_key) DO NOTHING
  RETURNING request_id
`;

const CLAIM_SQL = `
  UPDATE idempotency_records
  SET request_fingerprint = decode($4, 'hex'),
      state = 'pending',
      request_id = $5,
      response_status = NULL,
      response_body = NULL,
      created_at = now(),
      completed_at = NULL,
      expires_at = $6
  WHERE organization_id = $1
    AND operation = $2
    AND idempotency_key = $3
    AND (
      expires_at <= now()
      OR (state = 'failed' AND request_fingerprint = decode($4, 'hex'))
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
  WHERE organization_id = $1
    AND operation = $2
    AND idempotency_key = $3
  LIMIT 1
`;

const COMPLETE_SQL = `
  UPDATE idempotency_records
  SET state = 'completed',
      response_status = $5,
      response_body = $6,
      completed_at = now()
  WHERE organization_id = $1
    AND operation = $2
    AND idempotency_key = $3
    AND request_id = $4
    AND state = 'pending'
`;

const FAILED_SQL = `
  UPDATE idempotency_records
  SET state = 'failed',
      response_status = NULL,
      response_body = NULL,
      completed_at = NULL
  WHERE organization_id = $1
    AND operation = $2
    AND idempotency_key = $3
    AND request_id = $4
    AND state = 'pending'
`;

const DELETE_SQL = `
  DELETE FROM idempotency_records
  WHERE organization_id = $1
    AND operation = $2
    AND idempotency_key = $3
    AND request_id = $4
    AND state = 'pending'
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
    httpStatus: 500,
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
    await this.client.query(COMPLETE_SQL, [
      input.organizationId,
      input.operation,
      input.idempotencyKey,
      input.requestId,
      input.responseStatus,
      input.responseBody,
    ]);
  }

  async markFailed(input: IdempotencyAttemptInput): Promise<void> {
    await this.client.query(FAILED_SQL, [
      input.organizationId,
      input.operation,
      input.idempotencyKey,
      input.requestId,
    ]);
  }

  async delete(input: IdempotencyAttemptInput): Promise<void> {
    await this.client.query(DELETE_SQL, [
      input.organizationId,
      input.operation,
      input.idempotencyKey,
      input.requestId,
    ]);
  }

  async cleanupExpired(): Promise<number> {
    const rows = await this.client.query(CLEANUP_SQL, []);
    return rows.length;
  }
}

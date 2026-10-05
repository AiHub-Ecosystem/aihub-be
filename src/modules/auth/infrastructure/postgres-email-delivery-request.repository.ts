import { AppError } from '@/common/errors/app-error';
import type {
  ClaimEmailDeliveryRequestsInput,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDeliveryRequestStatus,
  EmailDispatchStorePort,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/application/email-delivery-request.port';

/**
 * Structural minimum for any client that can run a single statement: the auth
 * pool client, the identity client, and either one's transaction handle all
 * satisfy it, so a repository call can ride the caller's open transaction.
 */
export interface EmailDeliveryQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

const SELECT_ROW = `
  SELECT id, kind, status, payload_ciphertext, attempts, last_attempt_at,
         last_error_code, cancel_reason, created_at, completed_at
  FROM email_delivery_requests
  WHERE id = $1
`;

const INSERT_SQL = `
  INSERT INTO email_delivery_requests (id, kind, status, payload_ciphertext, created_at)
  VALUES ($1, $2, 'queued', $3, $4)
`;

/**
 * One statement, so the claim is atomic without a surrounding transaction: the
 * CTE takes row locks that `SKIP LOCKED` makes per-instance, and the update that
 * reads them can only see rows this claim actually won.
 *
 * A row is claimable when it is queued, still has attempts left, is not held by
 * a live lease, and has waited out its retry delay. `last_attempt_at IS NULL`
 * is a row that has never been attempted, which is due immediately. The delay
 * is one minute after the first attempt and five after the second; the `attempts`
 * cap in the table makes a fourth attempt impossible even if this predicate is
 * wrong, which is why the two live together.
 */
const CLAIM_SQL = `
  WITH claimable AS (
    SELECT id
    FROM email_delivery_requests
    WHERE status = 'queued'
      AND attempts < 3
      AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
      AND (
        last_attempt_at IS NULL
        OR last_attempt_at <= $1 - CASE attempts
             WHEN 0 THEN interval '0 seconds'
             WHEN 1 THEN interval '1 minute'
             ELSE interval '5 minutes'
           END
      )
    ORDER BY created_at, id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  UPDATE email_delivery_requests request
  SET lease_owner = $3, lease_expires_at = $1 + ($4 || ' milliseconds')::interval
  FROM claimable
  WHERE request.id = claimable.id
  RETURNING request.id, request.kind, request.status, request.payload_ciphertext,
            request.attempts, request.last_attempt_at, request.last_error_code,
            request.cancel_reason, request.created_at, request.completed_at
`;

/**
 * Each marker is one attempt, except cancellation, which happens before
 * dispatch. A marker only applies while the row is still queued, so a
 * terminal state can never be overwritten or revived, and every terminal
 * marker releases the lease it still holds.
 */
const RECORD_FAILED_ATTEMPT_SQL = `
  UPDATE email_delivery_requests
  SET attempts = attempts + 1, last_attempt_at = $2, last_error_code = $3
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

const MARK_PROVIDER_ACCEPTED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'provider_accepted', attempts = attempts + 1,
      last_attempt_at = $2, payload_ciphertext = NULL, completed_at = $2,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

const MARK_FAILED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'failed', attempts = attempts + 1, last_attempt_at = $2,
      last_error_code = $3, payload_ciphertext = NULL, completed_at = $2,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

const MARK_CANCELLED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'cancelled', cancel_reason = $2,
      payload_ciphertext = NULL, completed_at = $3,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

function storeError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

export class PostgresEmailDeliveryRequestRepository {
  async insert(
    client: EmailDeliveryQueryClient,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void> {
    await client.query(INSERT_SQL, [
      input.id,
      input.kind,
      input.payloadCiphertext,
      input.createdAt,
    ]);
  }

  async recordFailedAttempt(
    client: EmailDeliveryQueryClient,
    input: { id: string; attemptedAt: Date; errorCode: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, RECORD_FAILED_ATTEMPT_SQL, [
      input.id,
      input.attemptedAt,
      input.errorCode,
    ]);
  }

  async markProviderAccepted(
    client: EmailDeliveryQueryClient,
    input: { id: string; attemptedAt: Date },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_PROVIDER_ACCEPTED_SQL, [
      input.id,
      input.attemptedAt,
    ]);
  }

  async markFailed(
    client: EmailDeliveryQueryClient,
    input: { id: string; failedAt: Date; errorCode: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_FAILED_SQL, [
      input.id,
      input.failedAt,
      input.errorCode,
    ]);
  }

  async markCancelled(
    client: EmailDeliveryQueryClient,
    input: { id: string; cancelledAt: Date; reason: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_CANCELLED_SQL, [
      input.id,
      input.reason,
      input.cancelledAt,
    ]);
  }

  async claim(
    client: EmailDeliveryQueryClient,
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await client.query(CLAIM_SQL, [
      input.now,
      input.limit,
      input.owner,
      String(input.leaseMs),
    ]);
    return rows.map((row) => this.toRecord(row));
  }

  private async apply(
    client: EmailDeliveryQueryClient,
    sql: string,
    values: readonly unknown[],
  ): Promise<EmailDeliveryRequestRecord> {
    const updated = await client.query(sql, values);
    if (updated.length === 0) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Email delivery request is not in a queued state',
        retryable: false,
      });
    }
    const rows = await client.query(SELECT_ROW, [values[0]]);
    const row = rows[0];
    if (row === undefined) {
      throw storeError('Email delivery request is unavailable');
    }
    return this.toRecord(row);
  }

  private toRecord(row: Record<string, unknown>): EmailDeliveryRequestRecord {
    return {
      id: row.id as string,
      kind: row.kind as EmailDeliveryKind,
      status: row.status as EmailDeliveryRequestStatus,
      payloadCiphertext: row.payload_ciphertext as string | null,
      attempts: Number(row.attempts),
      lastAttemptAt: (row.last_attempt_at as Date | null) ?? null,
      lastErrorCode: row.last_error_code as string | null,
      cancelReason: row.cancel_reason as string | null,
      createdAt: row.created_at as Date,
      completedAt: (row.completed_at as Date | null) ?? null,
    };
  }
}

/**
 * The same statements, reached through the pool instead of a caller's open
 * transaction. The poller owns its own transactions — it claims in one
 * statement and dispatches outside any transaction, so nothing holds a
 * connection while a provider call is in flight.
 */
export class PostgresEmailDispatchStore implements EmailDispatchStorePort {
  constructor(
    private readonly client: EmailDeliveryQueryClient,
    private readonly requests: PostgresEmailDeliveryRequestRepository = new PostgresEmailDeliveryRequestRepository(),
  ) {}

  claim(
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    return this.requests.claim(this.client, input);
  }

  async markProviderAccepted(input: {
    readonly id: string;
    readonly attemptedAt: Date;
  }): Promise<void> {
    await this.requests.markProviderAccepted(this.client, input);
  }

  async markFailed(input: {
    readonly id: string;
    readonly failedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
  }): Promise<void> {
    await this.requests.markFailed(this.client, input);
  }

  async markCancelled(input: {
    readonly id: string;
    readonly cancelledAt: Date;
    readonly reason: EmailDeliveryCancelReason;
  }): Promise<void> {
    await this.requests.markCancelled(this.client, input);
  }

  async recordFailedAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
  }): Promise<void> {
    await this.requests.recordFailedAttempt(this.client, input);
  }
}

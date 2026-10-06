import { AppError } from '@/common/errors/app-error';
import type {
  ClaimEmailDeliveryRequestsInput,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/application/email-delivery-request.port';
import {
  EMAIL_DELIVERY_CANCEL_REASONS,
  EMAIL_DELIVERY_ERROR_CODES,
  EMAIL_DELIVERY_KINDS,
  EMAIL_DELIVERY_REQUEST_STATUSES,
} from '@/modules/auth/application/email-delivery-request.port';

import {
  dateValue,
  integerValue,
  isRecord,
  nullableDateValue,
  nullableOneOf,
  nullableStringValue,
  oneOf,
  stringValue,
} from './auth-row';

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
 * One attempt, taken before the provider is called. `attempts < 3` is the
 * predicate that makes the cap hard rather than advisory: once the third
 * reservation has committed no further claim can match this row, whatever the
 * transition after the call went on to do.
 *
 * The lease is deliberately left held. This poller still owns the row while the
 * provider is in flight; a process that dies here releases it by lapsing.
 */
const RESERVE_ATTEMPT_SQL = `
  UPDATE email_delivery_requests
  SET attempts = attempts + 1, last_attempt_at = $2
  WHERE id = $1 AND status = 'queued' AND lease_owner = $3::text AND attempts < 3
  RETURNING id
`;

/**
 * A failed attempt releases the lease, because the row stays queued and its
 * retry delay becomes the only thing that decides when it is claimable again.
 * Holding a lease until the lease expired would add the lease length to every
 * retry delay. The attempt itself was already counted by the reservation.
 */
const RECORD_FAILED_ATTEMPT_SQL = `
  UPDATE email_delivery_requests
  SET last_attempt_at = $2, last_error_code = $4,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued' AND lease_owner = $3::text
  RETURNING id
`;

const MARK_PROVIDER_ACCEPTED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'provider_accepted', last_attempt_at = $2,
      payload_ciphertext = NULL, completed_at = $2,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued' AND lease_owner = $3::text
  RETURNING id
`;

const MARK_FAILED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'failed', last_attempt_at = $2,
      last_error_code = $3, payload_ciphertext = NULL, completed_at = $2,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued' AND lease_owner = $4::text
  RETURNING id
`;

const MARK_CANCELLED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'cancelled', cancel_reason = $2,
      payload_ciphertext = NULL, completed_at = $3,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued' AND lease_owner = $4::text
  RETURNING id
`;

/**
 * A request that spent its last attempt but whose outcome was never written:
 * the process exited, or the transition after the provider call could not
 * commit. The claim predicate excludes it because `attempts` reached the cap,
 * so nothing else would ever move it, and it would keep its ciphertext and
 * never report. This gives up such a row without a fourth provider call.
 *
 * It takes no lease, because there is no claimant to fence: the row is only
 * claimable once its lease lapsed, which is exactly the state that means nobody
 * is still working on it.
 */
const FAIL_EXHAUSTED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'failed', last_attempt_at = COALESCE(last_attempt_at, $1),
      last_error_code = 'outcome_unknown', payload_ciphertext = NULL,
      completed_at = $1, lease_owner = NULL, lease_expires_at = NULL
  WHERE status = 'queued'
    AND attempts >= 3
    AND last_error_code IS NOT NULL
    AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
  RETURNING id
`;

/**
 * Releases a claim this instance cannot finish and records nothing else: no
 * attempt, no attempt time, no terminal state. That is what leaves a row sealed
 * with a key version only another instance holds deliverable, rather than
 * cancelled with its payload erased.
 */
const RELEASE_DEFERRED_SQL = `
  UPDATE email_delivery_requests
  SET lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND status = 'queued' AND lease_owner = $2::text
  RETURNING id
`;

/**
 * Terminal requests whose alert never went out. A request only reaches `failed`
 * by spending its third attempt, so this is a bounded and normally empty set;
 * it becomes non-empty exactly when a process exited between that commit and the
 * callback, which is the gap the runbook's alert depends on not existing.
 *
 * Claiming is one atomic step, so two instances reconciling at once do not both
 * report the same failure. The claim writes a lease rather than the reported
 * stamp, because the row has to stay claimable if this instance dies before it
 * emits: a stamp written here would lose that alert for good, while a lease only
 * delays it until the lease lapses.
 */
const CLAIM_UNREPORTED_FAILURES_SQL = `
  UPDATE email_delivery_requests
  SET failure_notify_lease_expires_at = $3
  WHERE id IN (
    SELECT id
    FROM email_delivery_requests
    WHERE status = 'failed'
      AND failure_reported_at IS NULL
      AND last_error_code IS NOT NULL
      AND (failure_notify_lease_expires_at IS NULL
           OR failure_notify_lease_expires_at <= $2)
    ORDER BY completed_at, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, kind, status, payload_ciphertext, attempts, last_attempt_at,
            last_error_code, cancel_reason, created_at, completed_at
`;

/**
 * Written only after the signal was emitted, and it takes the lease with it, so
 * a reported row is never claimed again. It requires the row to still be
 * `failed`, which a terminal state can never leave.
 */
const MARK_FAILURE_REPORTED_SQL = `
  UPDATE email_delivery_requests
  SET failure_reported_at = $2, failure_notify_lease_expires_at = NULL
  WHERE id = $1 AND status = 'failed'
  RETURNING id
`;

/**
 * Gives up a claim without emitting, so a callback that threw does not lock the
 * row out until the lease lapses.
 */
const RELEASE_FAILURE_NOTIFICATION_SQL = `
  UPDATE email_delivery_requests
  SET failure_notify_lease_expires_at = NULL
  WHERE id = $1 AND status = 'failed' AND failure_reported_at IS NULL
  RETURNING id
`;

function storeError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

/**
 * Every column crosses a reader, so a row the table could not have produced is
 * refused rather than asserted into a record. The error code and cancellation
 * reason are the two columns whose vocabulary the check constraint only bounds
 * by shape, so they are validated against the same lists the port declares.
 */
function toRecord(value: unknown): EmailDeliveryRequestRecord {
  if (!isRecord(value)) {
    throw storeError('Email delivery request is invalid');
  }

  const id = stringValue(value, 'id');
  const kind = oneOf(value, 'kind', EMAIL_DELIVERY_KINDS);
  const status = oneOf(value, 'status', EMAIL_DELIVERY_REQUEST_STATUSES);
  const payloadCiphertext = nullableStringValue(value, 'payload_ciphertext');
  const attempts = integerValue(value, 'attempts');
  const lastAttemptAt = nullableDateValue(value, 'last_attempt_at');
  const lastErrorCode = nullableOneOf(
    value,
    'last_error_code',
    EMAIL_DELIVERY_ERROR_CODES,
  );
  const cancelReason = nullableOneOf(
    value,
    'cancel_reason',
    EMAIL_DELIVERY_CANCEL_REASONS,
  );
  const createdAt = dateValue(value, 'created_at');
  const completedAt = nullableDateValue(value, 'completed_at');

  if (
    id === undefined ||
    kind === undefined ||
    status === undefined ||
    payloadCiphertext === undefined ||
    attempts === undefined ||
    lastAttemptAt === undefined ||
    createdAt === undefined ||
    completedAt === undefined ||
    lastErrorCode === undefined ||
    cancelReason === undefined
  ) {
    throw storeError('Email delivery request is invalid');
  }

  return {
    id,
    kind,
    status,
    payloadCiphertext,
    attempts,
    lastAttemptAt,
    lastErrorCode,
    cancelReason,
    createdAt,
    completedAt,
  };
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
    input: {
      id: string;
      attemptedAt: Date;
      errorCode: EmailDeliveryErrorCode;
      owner: string;
    },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, RECORD_FAILED_ATTEMPT_SQL, [
      input.id,
      input.attemptedAt,
      input.owner,
      input.errorCode,
    ]);
  }

  async reserveAttempt(
    client: EmailDeliveryQueryClient,
    input: { id: string; attemptedAt: Date; owner: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, RESERVE_ATTEMPT_SQL, [
      input.id,
      input.attemptedAt,
      input.owner,
    ]);
  }

  async markProviderAccepted(
    client: EmailDeliveryQueryClient,
    input: { id: string; attemptedAt: Date; owner: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_PROVIDER_ACCEPTED_SQL, [
      input.id,
      input.attemptedAt,
      input.owner,
    ]);
  }

  async markFailed(
    client: EmailDeliveryQueryClient,
    input: {
      id: string;
      failedAt: Date;
      errorCode: EmailDeliveryErrorCode;
      owner: string;
    },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_FAILED_SQL, [
      input.id,
      input.failedAt,
      input.errorCode,
      input.owner,
    ]);
  }

  async failExhausted(
    client: EmailDeliveryQueryClient,
    input: { at: Date },
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await client.query(FAIL_EXHAUSTED_SQL, [input.at]);
    return rows.map(toRecord);
  }

  async markCancelled(
    client: EmailDeliveryQueryClient,
    input: {
      id: string;
      cancelledAt: Date;
      reason: EmailDeliveryCancelReason;
      owner: string;
    },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_CANCELLED_SQL, [
      input.id,
      input.reason,
      input.cancelledAt,
      input.owner,
    ]);
  }

  async releaseDeferred(
    client: EmailDeliveryQueryClient,
    input: { id: string; owner: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, RELEASE_DEFERRED_SQL, [input.id, input.owner]);
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
    return rows.map(toRecord);
  }

  async claimUnreportedFailures(
    client: EmailDeliveryQueryClient,
    input: { limit: number; now: Date; leaseMs: number },
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await client.query(CLAIM_UNREPORTED_FAILURES_SQL, [
      input.limit,
      input.now,
      new Date(input.now.getTime() + input.leaseMs),
    ]);
    return rows.map(toRecord);
  }

  async markFailureReported(
    client: EmailDeliveryQueryClient,
    input: { id: string; reportedAt: Date },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_FAILURE_REPORTED_SQL, [
      input.id,
      input.reportedAt,
    ]);
  }

  async releaseFailureNotification(
    client: EmailDeliveryQueryClient,
    input: { id: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, RELEASE_FAILURE_NOTIFICATION_SQL, [input.id]);
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
    return toRecord(row);
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
    readonly owner: string;
  }): Promise<void> {
    await this.requests.markProviderAccepted(this.client, input);
  }

  async markFailed(input: {
    readonly id: string;
    readonly failedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.markFailed(this.client, input);
  }

  async failExhausted(input: {
    readonly at: Date;
  }): Promise<readonly EmailDeliveryRequestRecord[]> {
    return this.requests.failExhausted(this.client, input);
  }

  async markCancelled(input: {
    readonly id: string;
    readonly cancelledAt: Date;
    readonly reason: EmailDeliveryCancelReason;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.markCancelled(this.client, input);
  }

  async recordFailedAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.recordFailedAttempt(this.client, input);
  }

  async reserveAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.reserveAttempt(this.client, input);
  }

  async releaseDeferred(input: {
    readonly id: string;
    readonly owner: string;
  }): Promise<void> {
    await this.requests.releaseDeferred(this.client, input);
  }

  claimUnreportedFailures(input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<readonly EmailDeliveryRequestRecord[]> {
    return this.requests.claimUnreportedFailures(this.client, input);
  }

  async markFailureReported(input: {
    readonly id: string;
    readonly reportedAt: Date;
  }): Promise<void> {
    await this.requests.markFailureReported(this.client, input);
  }

  async releaseFailureNotification(input: {
    readonly id: string;
  }): Promise<void> {
    await this.requests.releaseFailureNotification(this.client, input);
  }
}

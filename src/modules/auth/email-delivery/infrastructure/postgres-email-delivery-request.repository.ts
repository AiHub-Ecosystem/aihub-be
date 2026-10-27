import { AppError } from '@/common/errors/app-error';
import type {
  CancelStaleEmailDeliveryRequestsInput,
  ClaimEmailDeliveryRequestsInput,
  ClaimedFailureReport,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  EMAIL_DELIVERY_CANCEL_REASONS,
  EMAIL_DELIVERY_ERROR_CODES,
  EMAIL_DELIVERY_KINDS,
  EMAIL_DELIVERY_REQUEST_STATUSES,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';
import { Logger } from '@nestjs/common';
import { reserveAuthenticationEmailRecipient } from './auth-email-recipient-limit';
import { EmailDeliveryTransactionAdapter } from './email-delivery-transaction.adapter';
import {
  CLAIM_UNREPORTED_FAILURES_SQL,
  withFailureClaims,
} from './email-failure-report-claim';

import { isRecord } from '@/common/is-record';
import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import {
  dateValue,
  integerValue,
  nullableDateValue,
  nullableOneOf,
  nullableStringValue,
  oneOf,
  stringValue,
} from '@/modules/auth/shared/infrastructure/auth-row';
import { claimEmailDeliveryRequests } from './email-delivery-claim';
import { CANCEL_STALE_EMAIL_DELIVERY_REQUESTS_SQL } from './email-delivery-stale-cancellation';

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
 *
 * It does not ask for prior error evidence. A process that dies after each of
 * the three reservations leaves `last_error_code` NULL, and that row is exactly
 * as stuck as one whose third outcome failed to commit.
 */
const FAIL_EXHAUSTED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'failed', last_attempt_at = COALESCE(last_attempt_at, $1),
      last_error_code = 'outcome_unknown', payload_ciphertext = NULL,
      completed_at = $1, lease_owner = NULL, lease_expires_at = NULL,
      organization_id = NULL, inviter_id = NULL
  WHERE status = 'queued'
    AND kind = ANY($2::text[])
    AND attempts >= 3
    AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
  RETURNING id, kind, status,
            payload_ciphertext AS "payloadCiphertext", attempts,
            last_attempt_at AS "lastAttemptAt",
            last_error_code AS "lastErrorCode",
            cancel_reason AS "cancelReason",
            created_at AS "createdAt", completed_at AS "completedAt"
`;

/**
 * What an operator alerts on when dispatch stops: how many requests wait in
 * each kind, and how long the oldest has waited. Read from the table rather
 * than from the poller, so it keeps rising when no instance is dispatching.
 */
const BACKLOG_SQL = `
  SELECT CASE WHEN kind = ANY($2::text[]) THEN kind ELSE 'unknown' END AS kind,
         count(*)::int AS queued,
         EXTRACT(EPOCH FROM ($1::timestamptz - min(created_at)))::float8 AS oldest_age_seconds
  FROM email_delivery_requests
  WHERE status = 'queued'
  GROUP BY 1
`;

function storeError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

const logger = new Logger('EmailOutboxDispatch');
let lastReportedUnknownKindCount = 0;

function reportUnknownKindRows(count: number): void {
  if (count === lastReportedUnknownKindCount) return;
  lastReportedUnknownKindCount = count;
  if (count > 0) {
    logger.warn(
      `Skipped ${count} email delivery requests with unrecognized kinds`,
    );
  }
}

function isKnownEmailDeliveryKind(value: unknown): value is EmailDeliveryKind {
  return (
    typeof value === 'string' &&
    EMAIL_DELIVERY_KINDS.some((kind) => kind === value)
  );
}

function toKnownRecords(
  rows: readonly Record<string, unknown>[],
): readonly EmailDeliveryRequestRecord[] {
  const records: EmailDeliveryRequestRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (typeof row.kind === 'string' && !isKnownEmailDeliveryKind(row.kind)) {
      skipped += 1;
      continue;
    }
    records.push(toRecord(row));
  }
  reportUnknownKindRows(skipped);
  return records;
}

/**
 * Every column crosses a reader, so a row the table could not have produced is
 * refused rather than asserted into a record. The error code and cancellation
 * reason are the two columns whose vocabulary the check constraint only bounds
 * by shape, so they are validated against the same lists the port declares.
 */
/** One kind's share of the queue, as the backlog metrics expose it. */
export interface EmailDeliveryBacklogRow {
  readonly kind: EmailDeliveryKind | 'unknown';
  readonly queued: number;
  readonly oldestAgeSeconds: number;
}

function toBacklogRow(value: unknown): EmailDeliveryBacklogRow {
  if (!isRecord(value)) {
    throw storeError('Email delivery backlog is invalid');
  }
  const kind =
    value.kind === 'unknown'
      ? 'unknown'
      : oneOf(value, 'kind', EMAIL_DELIVERY_KINDS);
  const queued = integerValue(value, 'queued');
  const oldestAgeSeconds = value.oldest_age_seconds;
  if (
    kind === undefined ||
    queued === undefined ||
    typeof oldestAgeSeconds !== 'number' ||
    !Number.isFinite(oldestAgeSeconds)
  ) {
    throw storeError('Email delivery backlog is invalid');
  }
  // The query's clock and the database's insert clock can disagree by a little,
  // and an age is never negative.
  return { kind, queued, oldestAgeSeconds: Math.max(0, oldestAgeSeconds) };
}

function toRecord(value: unknown): EmailDeliveryRequestRecord {
  if (!isRecord(value)) {
    throw storeError('Email delivery request is invalid');
  }

  const id = stringValue(value, 'id');
  const kind = oneOf(value, 'kind', EMAIL_DELIVERY_KINDS);
  const status = oneOf(value, 'status', EMAIL_DELIVERY_REQUEST_STATUSES);
  const payloadCiphertext = nullableStringValue(value, 'payloadCiphertext');
  const attempts = integerValue(value, 'attempts');
  const lastAttemptAt = nullableDateValue(value, 'lastAttemptAt');
  const lastErrorCode = nullableOneOf(
    value,
    'lastErrorCode',
    EMAIL_DELIVERY_ERROR_CODES,
  );
  const cancelReason = nullableOneOf(
    value,
    'cancelReason',
    EMAIL_DELIVERY_CANCEL_REASONS,
  );
  const createdAt = dateValue(value, 'createdAt');
  const completedAt = nullableDateValue(value, 'completedAt');

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

export class PostgresEmailDeliveryRequestRepository
  implements EmailDeliveryRequestWriterPort
{
  constructor(
    private readonly emailOutboxSecrets?: EmailOutboxRuntimeSecrets,
  ) {}

  async reserveAuthenticationEmailRecipient(
    transaction: EmailDeliveryTransaction,
    input: { readonly email: string; readonly now: Date },
  ): Promise<boolean> {
    return reserveAuthenticationEmailRecipient(
      (transaction as EmailDeliveryTransactionAdapter).client,
      this.emailOutboxSecrets,
      input,
    );
  }

  async insert(
    transaction: EmailDeliveryTransaction,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void> {
    const client = (transaction as EmailDeliveryTransactionAdapter).client;
    await client.emailDeliveryRequest.create({
      data: {
        id: input.id,
        kind: input.kind,
        status: 'queued',
        payloadCiphertext: input.payloadCiphertext,
        createdAt: input.createdAt,
        ...(input.kind === 'organization_invite_email'
          ? {
              organizationId: input.organizationId,
              inviterId: input.inviterId,
            }
          : {}),
      },
    });
  }

  async queuedPayloadCiphertexts(
    transaction: EmailDeliveryTransaction,
    input: { kind: EmailDeliveryKind },
  ): Promise<
    readonly { readonly id: string; readonly payloadCiphertext: string }[]
  > {
    const client = (transaction as EmailDeliveryTransactionAdapter).client;
    const rows = await client.emailDeliveryRequest.findMany({
      select: { id: true, payloadCiphertext: true },
      where: {
        kind: input.kind,
        status: 'queued',
        leaseOwner: null,
      },
    });
    return rows.flatMap((row) =>
      row.payloadCiphertext === null
        ? []
        : [{ id: row.id, payloadCiphertext: row.payloadCiphertext }],
    );
  }

  async cancelQueued(
    transaction: EmailDeliveryTransaction,
    input: {
      ids: readonly string[];
      reason: EmailDeliveryCancelReason;
      cancelledAt: Date;
    },
  ): Promise<void> {
    if (input.ids.length === 0) return;
    const client = (transaction as EmailDeliveryTransactionAdapter).client;
    await client.emailDeliveryRequest.updateMany({
      where: {
        id: { in: [...input.ids] },
        status: 'queued',
        leaseOwner: null,
      },
      data: {
        status: 'cancelled',
        cancelReason: input.reason,
        payloadCiphertext: null,
        completedAt: input.cancelledAt,
      },
    });
  }

  async recordFailedAttempt(
    client: AuthSqlClient,
    input: {
      id: string;
      attemptedAt: Date;
      errorCode: EmailDeliveryErrorCode;
      owner: string;
    },
  ): Promise<EmailDeliveryRequestRecord> {
    // A failed attempt releases the lease, because the row stays queued and
    // its retry delay becomes the only thing that decides when it is claimable
    // again. Holding a lease until it expired would add the lease length to
    // every retry delay. The attempt itself was already counted.
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'queued', leaseOwner: input.owner },
        data: {
          lastAttemptAt: input.attemptedAt,
          lastErrorCode: input.errorCode,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  async reserveAttempt(
    client: AuthSqlClient,
    input: { id: string; attemptedAt: Date; owner: string },
  ): Promise<EmailDeliveryRequestRecord> {
    // One attempt, taken before the provider is called. `attempts < 3` is what
    // makes the cap hard rather than advisory: once the third reservation has
    // committed no further claim can match this row. The lease is deliberately
    // left held; a process that dies here releases it by lapsing.
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: {
          id: input.id,
          status: 'queued',
          leaseOwner: input.owner,
          attempts: { lt: 3 },
        },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: input.attemptedAt,
        },
      }),
    );
  }

  async markProviderAccepted(
    client: AuthSqlClient,
    input: { id: string; attemptedAt: Date; owner: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'queued', leaseOwner: input.owner },
        data: {
          status: 'provider_accepted',
          lastAttemptAt: input.attemptedAt,
          payloadCiphertext: null,
          organizationId: null,
          inviterId: null,
          completedAt: input.attemptedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  async markFailed(
    client: AuthSqlClient,
    input: {
      id: string;
      failedAt: Date;
      errorCode: EmailDeliveryErrorCode;
      owner: string;
    },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'queued', leaseOwner: input.owner },
        data: {
          status: 'failed',
          lastAttemptAt: input.failedAt,
          lastErrorCode: input.errorCode,
          payloadCiphertext: null,
          organizationId: null,
          inviterId: null,
          completedAt: input.failedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  async failExhausted(
    client: AuthSqlClient,
    input: { at: Date },
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await authQueryRows(client, FAIL_EXHAUSTED_SQL, [
      input.at,
      EMAIL_DELIVERY_KINDS,
    ]);
    return toKnownRecords(rows);
  }

  async markCancelled(
    client: AuthSqlClient,
    input: {
      id: string;
      cancelledAt: Date;
      reason: EmailDeliveryCancelReason;
      owner: string;
    },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'queued', leaseOwner: input.owner },
        data: {
          status: 'cancelled',
          cancelReason: input.reason,
          payloadCiphertext: null,
          organizationId: null,
          inviterId: null,
          completedAt: input.cancelledAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  async releaseDeferred(
    client: AuthSqlClient,
    input: { id: string; owner: string; retryAt: Date },
  ): Promise<EmailDeliveryRequestRecord> {
    // Releases a claim this instance cannot finish and records nothing else:
    // no attempt, no attempt time, no terminal state. The lease time moves to
    // the retry time rather than being cleared, because the claim treats a
    // lease in the future as held, so the row stays out of every batch until
    // then instead of coming straight back on the next pass. Stale
    // cancellation does not: an ownerless row is cancellable at any time.
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'queued', leaseOwner: input.owner },
        data: { leaseOwner: null, leaseExpiresAt: input.retryAt },
      }),
    );
  }

  async cancelStale(
    client: AuthSqlClient,
    input: CancelStaleEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await authQueryRows(
      client,
      CANCEL_STALE_EMAIL_DELIVERY_REQUESTS_SQL,
      [input.at, input.createdAtOrBefore, input.kinds],
    );
    return toKnownRecords(rows);
  }

  async backlog(
    client: AuthSqlClient,
    input: { now: Date },
  ): Promise<readonly EmailDeliveryBacklogRow[]> {
    const rows = await authQueryRows(client, BACKLOG_SQL, [
      input.now,
      EMAIL_DELIVERY_KINDS,
    ]);
    const backlog = rows.map(toBacklogRow);
    reportUnknownKindRows(
      backlog.find((row) => row.kind === 'unknown')?.queued ?? 0,
    );
    return backlog;
  }

  async claim(
    client: Parameters<typeof claimEmailDeliveryRequests>[0],
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    return claimEmailDeliveryRequests(client, input, toKnownRecords);
  }

  async claimUnreportedFailures(
    client: AuthSqlClient,
    input: { limit: number; now: Date; leaseMs: number },
  ): Promise<readonly ClaimedFailureReport[]> {
    const rows = await authQueryRows(client, CLAIM_UNREPORTED_FAILURES_SQL, [
      input.limit,
      input.now,
      new Date(input.now.getTime() + input.leaseMs),
      EMAIL_DELIVERY_KINDS,
    ]);
    return withFailureClaims(rows, toKnownRecords(rows));
  }

  async markFailureReported(
    client: AuthSqlClient,
    input: { id: string; claim: Date; reportedAt: Date },
  ): Promise<EmailDeliveryRequestRecord> {
    // Written only after the signal was emitted, and it takes the lease with
    // it, so a reported row is never claimed again. It requires the row to
    // still be `failed`, which a terminal state can never leave, and the
    // lease to still be this claim's: a reporter whose lease lapsed and was
    // claimed again matches nothing (#989).
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: {
          id: input.id,
          status: 'failed',
          failureNotifyLeaseExpiresAt: input.claim,
        },
        data: {
          failureReportedAt: input.reportedAt,
          failureNotifyLeaseExpiresAt: null,
        },
      }),
    );
  }

  async releaseFailureNotification(
    client: AuthSqlClient,
    input: { id: string; claim: Date },
  ): Promise<EmailDeliveryRequestRecord> {
    // Gives up a claim without emitting, so a callback that threw does not
    // lock the row out until the lease lapses. Only the current claim can.
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: {
          id: input.id,
          status: 'failed',
          failureReportedAt: null,
          failureNotifyLeaseExpiresAt: input.claim,
        },
        data: { failureNotifyLeaseExpiresAt: null },
      }),
    );
  }

  private async apply(
    client: AuthSqlClient,
    id: string,
    update: () => Promise<{ readonly count: number }>,
  ): Promise<EmailDeliveryRequestRecord> {
    const updated = await update();
    if (updated.count === 0) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Email delivery request is not in a queued state',
        retryable: false,
      });
    }
    const row = await client.emailDeliveryRequest.findUnique({
      where: { id },
    });
    if (row === null) {
      throw storeError('Email delivery request is unavailable');
    }
    return toRecord(row);
  }
}

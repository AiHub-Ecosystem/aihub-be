// ponytail: file above the 500-code-line ceiling (ADR-0110); split tracked as follow-on.
import { createHmac, hkdfSync } from 'node:crypto';
import { AppError } from '@/common/errors/app-error';
import type {
  ClaimEmailDeliveryRequestsInput,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
  EmailDispatchStorePort,
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
import { EmailDeliveryTransactionAdapter } from './email-delivery-transaction.adapter';

import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import {
  dateValue,
  integerValue,
  isRecord,
  nullableDateValue,
  nullableOneOf,
  nullableStringValue,
  oneOf,
  stringValue,
} from '@/modules/auth/shared/infrastructure/auth-row';

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
      AND kind = ANY($5::text[])
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
  RETURNING request.id, request.kind, request.status,
            request.payload_ciphertext AS "payloadCiphertext",
            request.attempts,
            request.last_attempt_at AS "lastAttemptAt",
            request.last_error_code AS "lastErrorCode",
            request.cancel_reason AS "cancelReason",
            request.created_at AS "createdAt",
            request.completed_at AS "completedAt"
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
 *
 * It does not ask for prior error evidence. A process that dies after each of
 * the three reservations leaves `last_error_code` NULL, and that row is exactly
 * as stuck as one whose third outcome failed to commit.
 */
const FAIL_EXHAUSTED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'failed', last_attempt_at = COALESCE(last_attempt_at, $1),
      last_error_code = 'outcome_unknown', payload_ciphertext = NULL,
      completed_at = $1, lease_owner = NULL, lease_expires_at = NULL
  WHERE status = 'queued'
    AND kind = ANY($2::text[])
    AND attempts >= 3
    AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
  RETURNING id
`;

/**
 * Queued requests older than every credential an Email Delivery Request can
 * carry. None of them can be sent any more, so they are cancelled as expired
 * and their payload erased without being opened, which is the only way a
 * payload no instance can decrypt still leaves the table (ADR-0074). A row
 * still under a live lease is left to the instance that holds it.
 */
const CANCEL_STALE_SQL = `
  UPDATE email_delivery_requests
  SET status = 'cancelled', cancel_reason = 'credential_expired',
      payload_ciphertext = NULL, completed_at = $1,
      lease_owner = NULL, lease_expires_at = NULL
  WHERE status = 'queued'
    AND kind = ANY($3::text[])
    AND created_at <= $2
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

const AUTH_EMAIL_RECIPIENT_LIMIT = 9;
const AUTH_EMAIL_RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface AuthEmailRecipientFingerprint {
  readonly keyVersion: string;
  readonly addressHmac: string;
}

interface AuthEmailRecipientLimitRow {
  readonly key_version: string;
  readonly address_hmac: string;
  readonly window_started_at: Date | string;
  readonly expires_at: Date | string;
  readonly request_count: number;
}

function fingerprintEmailRecipients(
  email: string,
  secrets: EmailOutboxRuntimeSecrets | undefined,
): readonly AuthEmailRecipientFingerprint[] {
  if (secrets === undefined) {
    throw new Error('authentication email recipient keyring is unavailable');
  }
  return Object.entries(secrets.keys)
    .map(([keyVersion, encodedKey]) => {
      const masterKey = Buffer.from(encodedKey, 'base64');
      if (masterKey.length !== 32) {
        throw new Error('authentication email recipient key is invalid');
      }
      const key = Buffer.from(
        hkdfSync(
          'sha256',
          masterKey,
          'aihub-auth-email-recipient-rate-limit-v1',
          `recipient-address:${keyVersion}`,
          32,
        ),
      );
      return {
        keyVersion,
        addressHmac: createHmac('sha256', key)
          .update(email, 'utf8')
          .digest('hex'),
      };
    })
    .sort((left, right) =>
      `${left.keyVersion}:${left.addressHmac}`.localeCompare(
        `${right.keyVersion}:${right.addressHmac}`,
      ),
    );
}

function counterDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('authentication email recipient counter is invalid');
  }
  return date;
}

export async function pruneExpiredAuthEmailRecipientLimits(
  client: AuthSqlClient,
  now: Date,
): Promise<number> {
  const rows = await authQueryRows<{ readonly key_version: string }>(
    client,
    `DELETE FROM auth_email_recipient_rate_limits
     WHERE expires_at <= $1
     RETURNING key_version`,
    [now],
  );
  return rows.length;
}

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
      AND kind = ANY($4::text[])
      AND failure_reported_at IS NULL
      AND last_error_code IS NOT NULL
      AND (failure_notify_lease_expires_at IS NULL
           OR failure_notify_lease_expires_at <= $2)
    ORDER BY completed_at, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, kind, status,
            payload_ciphertext AS "payloadCiphertext", attempts,
            last_attempt_at AS "lastAttemptAt",
            last_error_code AS "lastErrorCode",
            cancel_reason AS "cancelReason",
            created_at AS "createdAt", completed_at AS "completedAt"
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
    const client = (transaction as EmailDeliveryTransactionAdapter).client;
    const fingerprints = fingerprintEmailRecipients(
      input.email,
      this.emailOutboxSecrets,
    );
    for (const fingerprint of fingerprints) {
      await authQueryRows(
        client,
        `WITH lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
         )
         SELECT 1 AS locked FROM lock`,
        [
          `auth-email-recipient:${fingerprint.keyVersion}:${fingerprint.addressHmac}`,
        ],
      );
    }

    const active: AuthEmailRecipientLimitRow[] = [];
    for (const fingerprint of fingerprints) {
      const rows = await authQueryRows<AuthEmailRecipientLimitRow>(
        client,
        `SELECT key_version, address_hmac, window_started_at, expires_at,
                request_count
         FROM auth_email_recipient_rate_limits
         WHERE key_version = $1 AND address_hmac = $2 AND expires_at > $3
         FOR UPDATE`,
        [fingerprint.keyVersion, fingerprint.addressHmac, input.now],
      );
      active.push(...rows);
    }

    const requestCount = Math.max(
      0,
      ...active.map((row) => {
        if (!Number.isInteger(row.request_count) || row.request_count < 1) {
          throw new Error('authentication email recipient counter is invalid');
        }
        return row.request_count;
      }),
    );
    const currentFingerprint = fingerprints.find(
      ({ keyVersion }) => keyVersion === this.emailOutboxSecrets?.currentKeyId,
    );
    if (currentFingerprint === undefined) {
      throw new Error(
        'authentication email recipient key version is unavailable',
      );
    }
    const existingCounter = active
      .slice()
      .sort(
        (left, right) =>
          counterDate(left.expires_at).getTime() -
          counterDate(right.expires_at).getTime(),
      )[0];
    const writeFingerprint =
      existingCounter === undefined
        ? currentFingerprint
        : fingerprints.find(
            ({ keyVersion, addressHmac }) =>
              keyVersion === existingCounter.key_version &&
              addressHmac === existingCounter.address_hmac,
          );
    if (writeFingerprint === undefined) {
      throw new Error(
        'authentication email recipient counter key is unavailable',
      );
    }
    const windowStartedAt =
      active.length === 0
        ? input.now
        : active
            .map((row) => counterDate(row.window_started_at))
            .reduce((earliest, value) => (value < earliest ? value : earliest));
    const expiresAt =
      active.length === 0
        ? new Date(input.now.getTime() + AUTH_EMAIL_RECIPIENT_WINDOW_MS)
        : active
            .map((row) => counterDate(row.expires_at))
            .reduce((earliest, value) => (value < earliest ? value : earliest));
    const nextCount = Math.min(
      AUTH_EMAIL_RECIPIENT_LIMIT,
      requestCount + (requestCount < AUTH_EMAIL_RECIPIENT_LIMIT ? 1 : 0),
    );

    await authQueryRows(
      client,
      `INSERT INTO auth_email_recipient_rate_limits (
         key_version, address_hmac, window_started_at, expires_at, request_count
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key_version, address_hmac) DO UPDATE
       SET window_started_at = EXCLUDED.window_started_at,
           expires_at = EXCLUDED.expires_at,
           request_count = EXCLUDED.request_count`,
      [
        writeFingerprint.keyVersion,
        writeFingerprint.addressHmac,
        windowStartedAt,
        expiresAt,
        nextCount,
      ],
    );
    return requestCount < AUTH_EMAIL_RECIPIENT_LIMIT;
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
    // then instead of coming straight back on the next pass.
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'queued', leaseOwner: input.owner },
        data: { leaseOwner: null, leaseExpiresAt: input.retryAt },
      }),
    );
  }

  async cancelStale(
    client: AuthSqlClient,
    input: { at: Date; createdAtOrBefore: Date },
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await authQueryRows(client, CANCEL_STALE_SQL, [
      input.at,
      input.createdAtOrBefore,
      EMAIL_DELIVERY_KINDS,
    ]);
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
    client: AuthSqlClient,
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await authQueryRows(client, CLAIM_SQL, [
      input.now,
      input.limit,
      input.owner,
      String(input.leaseMs),
      EMAIL_DELIVERY_KINDS,
    ]);
    return toKnownRecords(rows);
  }

  async claimUnreportedFailures(
    client: AuthSqlClient,
    input: { limit: number; now: Date; leaseMs: number },
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    const rows = await authQueryRows(client, CLAIM_UNREPORTED_FAILURES_SQL, [
      input.limit,
      input.now,
      new Date(input.now.getTime() + input.leaseMs),
      EMAIL_DELIVERY_KINDS,
    ]);
    return toKnownRecords(rows);
  }

  async markFailureReported(
    client: AuthSqlClient,
    input: { id: string; reportedAt: Date },
  ): Promise<EmailDeliveryRequestRecord> {
    // Written only after the signal was emitted, and it takes the lease with
    // it, so a reported row is never claimed again. It requires the row to
    // still be `failed`, which a terminal state can never leave.
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'failed' },
        data: {
          failureReportedAt: input.reportedAt,
          failureNotifyLeaseExpiresAt: null,
        },
      }),
    );
  }

  async releaseFailureNotification(
    client: AuthSqlClient,
    input: { id: string },
  ): Promise<EmailDeliveryRequestRecord> {
    // Gives up a claim without emitting, so a callback that threw does not
    // lock the row out until the lease lapses.
    return this.apply(client, input.id, () =>
      client.emailDeliveryRequest.updateMany({
        where: { id: input.id, status: 'failed', failureReportedAt: null },
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

/**
 * The same statements, reached through the pool instead of a caller's open
 * transaction. The poller owns its own transactions â€” it claims in one
 * statement and dispatches outside any transaction, so nothing holds a
 * connection while a provider call is in flight.
 */
export class PostgresEmailDispatchStore implements EmailDispatchStorePort {
  constructor(
    private readonly client: AuthSqlClient,
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
    readonly retryAt: Date;
  }): Promise<void> {
    await this.requests.releaseDeferred(this.client, input);
  }

  cancelStale(input: {
    readonly at: Date;
    readonly createdAtOrBefore: Date;
  }): Promise<readonly EmailDeliveryRequestRecord[]> {
    return this.requests.cancelStale(this.client, input);
  }

  /** Not part of the dispatch port: only the backlog metrics read it. */
  backlog(input: {
    readonly now: Date;
  }): Promise<readonly EmailDeliveryBacklogRow[]> {
    return this.requests.backlog(this.client, input);
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

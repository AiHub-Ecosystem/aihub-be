import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import type {
  ApiKeyNearExpiryNoticeResolverPort,
  ApiKeyNearExpiryNotificationInput,
  ApiKeyNearExpiryNotificationPayload,
  EmailDeliveryTransaction,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { emailDeliveryTransactionBrand } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import type {
  ApiKeyNearExpiryNoticeRecordPort,
  ApiKeyNearExpirySweepSummary,
  NotificationKind,
  RecordDueApiKeyNearExpiryNoticesInput,
} from '@/modules/identity/notifications/application/api-key-near-expiry-notice.port';
import { planApiKeyNearExpiryNotices } from '@/modules/identity/notifications/application/plan-api-key-near-expiry-notices';
import {
  dateValue,
  identityStoreError,
  identityStoreUnavailable,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

const KIND: NotificationKind = 'api-key.near-expiry';

/** A key the Organization can still lose: active, customer-owned, expiring. */
const DUE_KEYS_SQL = `
  SELECT api_key.id, api_key.organization_id, api_key.expires_at
  FROM api_keys AS api_key
  JOIN organizations AS organization
    ON organization.id = api_key.organization_id
   AND organization.status = 'active'
  WHERE api_key.status = 'active'
    AND api_key.revoked_at IS NULL
    AND NOT api_key.internal
    AND api_key.expires_at > $1
    AND api_key.expires_at <= $2
  ORDER BY api_key.id
`;

/**
 * The unique key decides which sweep records an event. A concurrent sweep's
 * insert waits on the first one's and then skips, so only one of them gets the
 * row back and queues email for it.
 */
const RECORD_EVENTS_SQL = `
  INSERT INTO notification_events (
    id, kind, organization_id, api_key_id, subject_expires_at, recorded_at
  )
  SELECT event.id, $5, event.organization_id, event.api_key_id,
         event.expires_at, $6
  FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
    AS event(id, organization_id, api_key_id, expires_at)
  ON CONFLICT (api_key_id, kind, subject_expires_at) DO NOTHING
  RETURNING organization_id, api_key_id
`;

const RECIPIENTS_SQL = `
  SELECT member.organization_id, member.user_account_id
  FROM organization_members AS member
  JOIN user_accounts AS account
    ON account.id = member.user_account_id
   AND account.status = 'active'
  JOIN auth_identities AS identity
    ON identity.user_account_id = account.id
   AND identity.provider = 'password'
  WHERE member.organization_id = ANY($1::text[])
    AND member.status = 'active'
    AND member.role IN ('owner', 'admin')
  ORDER BY member.organization_id, member.user_account_id
`;

const RECIPIENT_SQL = `
  SELECT organization.name, identity.canonical_email AS email
  FROM organizations AS organization
  JOIN organization_members AS member
    ON member.organization_id = organization.id
   AND member.user_account_id = $2
   AND member.status = 'active'
   AND member.role IN ('owner', 'admin')
  JOIN user_accounts AS account
    ON account.id = member.user_account_id
   AND account.status = 'active'
  JOIN auth_identities AS identity
    ON identity.user_account_id = account.id
   AND identity.provider = 'password'
  WHERE organization.id = $1
    AND organization.status = 'active'
`;

/**
 * Withdraws the events of a notice that cannot be sent because its Organization
 * is no longer active (#996). Without this, an event recorded for a key whose
 * Organization was suspended before dispatch would stop every later sweep from
 * recording it, and restoring the Organization inside the window would never
 * notify it. Only unexpired events go: an expired key is never notified again.
 *
 * The status check and the delete share one statement snapshot, and the answer
 * reports both sides of it: `inactive` is the status the delete acted on, and
 * `remaining` counts the unexpired events still standing afterwards. A
 * restoration committing around the statement is either visible (nothing is
 * withdrawn) or invisible (the withdrawal happened while the Organization
 * really was inactive) — the caller never has to guess which (#1128).
 */
const WITHDRAW_EVENTS_SQL = `
  WITH organization AS (
    SELECT status <> 'active' AS inactive
    FROM organizations
    WHERE id = $2
  ),
  withdrawn AS (
    DELETE FROM notification_events
    WHERE kind = $1
      AND organization_id = $2
      AND api_key_id = ANY($3::text[])
      AND subject_expires_at > $4
      AND (SELECT inactive FROM organization)
    RETURNING 1
  )
  SELECT
    COALESCE((SELECT inactive FROM organization), false) AS inactive,
    (SELECT count(*)::int FROM notification_events
      WHERE kind = $1
        AND organization_id = $2
        AND api_key_id = ANY($3::text[])
        AND subject_expires_at > $4) AS remaining
`;

const STILL_ACTIVE_KEYS_SQL = `
  SELECT id, name, expires_at
  FROM api_keys
  WHERE organization_id = $1
    AND id = ANY($2::text[])
    AND status = 'active'
    AND revoked_at IS NULL
    AND expires_at > $3
  ORDER BY expires_at, id
`;

function requiredString(row: unknown, field: string): string {
  const value = isRecord(row) ? stringValue(row, field) : undefined;
  if (value === undefined) throw identityStoreError('Identity data is invalid');
  return value;
}

function requiredDate(row: unknown, field: string): Date {
  const value = isRecord(row) ? dateValue(row, field) : undefined;
  if (value === undefined || value === null) {
    throw identityStoreError('Identity data is invalid');
  }
  return value;
}

type IdentityTransactionClient = Parameters<
  Parameters<typeof identityTransaction>[1]
>[0];

/** The email-delivery kind of this catalog's notice; `KIND` is the event's. */
const NOTICE_EMAIL_KIND = 'api_key_near_expiry_notification' as const;

/** Bridges an Identity transaction onto the writer port's transaction seam. */
function emailDeliveryTransactionOver(
  transaction: IdentityTransactionClient,
): EmailDeliveryTransaction {
  return {
    [emailDeliveryTransactionBrand]: undefined,
    client: transaction,
  } as EmailDeliveryTransaction;
}

/**
 * The near-expiry notice's two database moments (ADR-0120): the sweep that
 * records events and queues the email, and the dispatch that reads again what
 * is still true before the email goes out.
 */
export class PostgresApiKeyNearExpiryNotices
  implements
    ApiKeyNearExpiryNoticeRecordPort,
    ApiKeyNearExpiryNoticeResolverPort
{
  constructor(
    private readonly client: IdentityRepositoryClient,
    private readonly emailOutbox: EmailOutboxPort,
  ) {}

  async recordDue(
    input: RecordDueApiKeyNearExpiryNoticesInput,
  ): Promise<ApiKeyNearExpirySweepSummary> {
    try {
      return await identityTransaction(this.client, async (transaction) => {
        const due = (
          await identityRows(transaction, DUE_KEYS_SQL, [
            input.now,
            input.windowEnd,
          ])
        ).map((row) => ({
          id: requiredString(row, 'id'),
          organizationId: requiredString(row, 'organization_id'),
          expiresAt: requiredDate(row, 'expires_at'),
        }));
        if (due.length === 0) {
          return { eventsRecorded: 0, emailsQueued: 0, keysSkipped: 0 };
        }

        const recorded = (
          await identityRows(transaction, RECORD_EVENTS_SQL, [
            due.map(() => input.newEventId(input.now)),
            due.map((key) => key.organizationId),
            due.map((key) => key.id),
            due.map((key) => key.expiresAt),
            KIND,
            input.now,
          ])
        ).map((row) => ({
          organizationId: requiredString(row, 'organization_id'),
          apiKeyId: requiredString(row, 'api_key_id'),
        }));
        const recipients = (
          await identityRows(transaction, RECIPIENTS_SQL, [
            [...new Set(recorded.map((event) => event.organizationId))],
          ])
        ).map((row) => ({
          organizationId: requiredString(row, 'organization_id'),
          userAccountId: requiredString(row, 'user_account_id'),
        }));
        const notices = planApiKeyNearExpiryNotices(recorded, recipients);
        const emailTransaction = emailDeliveryTransactionOver(transaction);
        for (const payload of notices) {
          await this.emailOutbox.queue(emailTransaction, {
            kind: NOTICE_EMAIL_KIND,
            payload,
            createdAt: input.now,
          });
        }

        return {
          eventsRecorded: recorded.length,
          emailsQueued: notices.length,
          keysSkipped: due.length - recorded.length,
        };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw identityStoreUnavailable(error);
    }
  }

  async resolve(
    payload: ApiKeyNearExpiryNotificationPayload,
    now: Date,
  ): Promise<ApiKeyNearExpiryNotificationInput | undefined> {
    try {
      return await this.resolveFacts(payload, now);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw identityStoreUnavailable(error);
    }
  }

  private async resolveFacts(
    payload: ApiKeyNearExpiryNotificationPayload,
    now: Date,
  ): Promise<ApiKeyNearExpiryNotificationInput | undefined> {
    let recipient = await this.readRecipient(payload);
    if (recipient === undefined) {
      const events = await this.withdrawIfOrganizationInactive(payload, now);
      // The event is still standing and the Organization was active at the
      // withdrawal's snapshot, so the recipient read above ran on a suspended
      // snapshot that a restoration has since replaced: the lookup runs again
      // instead of cancelling the only notice this Organization gets (#1128).
      if (!events.inactive && events.remaining > 0) {
        recipient = await this.readRecipient(payload);
        if (recipient === undefined) {
          // A suspension that landed between the two reads leaves the events
          // standing while cancelling anyway; one more withdrawal makes the
          // cancellation safe by handing the events back to the next sweep.
          await this.withdrawIfOrganizationInactive(payload, now);
        }
      }
    }
    if (recipient === undefined) return undefined;

    const apiKeys = (
      await identityRows(this.client, STILL_ACTIVE_KEYS_SQL, [
        payload.organizationId,
        [...payload.apiKeyIds],
        now,
      ])
    ).map((row) => ({
      id: requiredString(row, 'id'),
      name: requiredString(row, 'name'),
      expiresAt: requiredDate(row, 'expires_at'),
    }));
    if (apiKeys.length === 0) return undefined;

    return {
      email: requiredString(recipient, 'email'),
      organizationId: payload.organizationId,
      organizationName: requiredString(recipient, 'name'),
      apiKeys,
    };
  }

  private async readRecipient(
    payload: ApiKeyNearExpiryNotificationPayload,
  ): Promise<Record<string, unknown> | undefined> {
    return (
      await identityRows(this.client, RECIPIENT_SQL, [
        payload.organizationId,
        payload.userAccountId,
      ])
    )[0];
  }

  /**
   * A recipient who no longer qualifies leaves the event alone: the
   * Organization was told, and recording it again would tell the other
   * recipients twice. An Organization that is no longer active was not told,
   * so its events go in the same statement that observed the status, and the
   * still-queued notices that cover those keys are cancelled with them in one
   * transaction (#1098): a restoration would otherwise re-record the event
   * and queue fresh notices alongside the old, telling each recipient twice.
   * The answer's `remaining` is what stands afterwards: zero also covers the
   * sibling notice that already withdrew the shared events (#1098), where
   * cancelling is equally safe because the next sweep records them again.
   */
  private async withdrawIfOrganizationInactive(
    payload: ApiKeyNearExpiryNotificationPayload,
    now: Date,
  ): Promise<{ readonly inactive: boolean; readonly remaining: number }> {
    return identityTransaction(this.client, async (transaction) => {
      const row = (
        await identityRows(transaction, WITHDRAW_EVENTS_SQL, [
          KIND,
          payload.organizationId,
          [...payload.apiKeyIds],
          now,
        ])
      )[0];
      const outcome = {
        inactive: isRecord(row) && row.inactive === true,
        remaining:
          isRecord(row) && typeof row.remaining === 'number'
            ? row.remaining
            : 0,
      };
      if (outcome.inactive) {
        await this.cancelQueuedSiblingsOfWithdrawnKeys(
          transaction,
          payload,
          now,
        );
      }
      return outcome;
    });
  }

  /**
   * The queued, unclaimed notices of the withdrawn keys. A notice claimed by a
   * dispatch in flight, or already sent, is left alone: its own dispatch owns
   * its outcome, and a sent notice's key set no longer exists to match
   * (accepted requests erase their payload). A payload this process cannot
   * open is no evidence that it covers the withdrawn keys, so it is skipped.
   */
  private async cancelQueuedSiblingsOfWithdrawnKeys(
    transaction: IdentityTransactionClient,
    payload: ApiKeyNearExpiryNotificationPayload,
    now: Date,
  ): Promise<void> {
    const emailTransaction = emailDeliveryTransactionOver(transaction);
    await this.emailOutbox.withdraw(emailTransaction, {
      kind: NOTICE_EMAIL_KIND,
      matches: (candidate) =>
        candidate.organizationId === payload.organizationId &&
        candidate.apiKeyIds.some((id) => payload.apiKeyIds.includes(id)),
      reason: 'not_actionable',
      cancelledAt: now,
    });
  }
}

import {
  EMAIL_DELIVERY_KINDS,
  EMAIL_KIND_POLICIES,
} from '@/modules/auth/email-delivery/application/email-kind-handler.registry';

const STALE_CANCELLATION_REASON_CASE = EMAIL_DELIVERY_KINDS.map(
  (kind) =>
    `WHEN '${kind}' THEN '${EMAIL_KIND_POLICIES[kind].staleCancellationReason}'`,
).join('\n        ');

/**
 * Removes queued rows of the given kinds created at or before the cutoff the
 * caller chose for them. Credential-bearing kinds are expired; notices have no
 * credential and are not actionable. Both paths erase the queued payload.
 * A row an instance is working on, one with a lease owner and a live lease,
 * is left to that instance. A deferred row has no owner: its lease time only
 * holds it back until its retry time (a Retry-After, a rate wait), so it stays
 * eligible here and is never sent after its credential expires (#1007).
 */
export const CANCEL_STALE_EMAIL_DELIVERY_REQUESTS_SQL = `
  UPDATE email_delivery_requests
  SET status = 'cancelled',
      cancel_reason = CASE kind
        ${STALE_CANCELLATION_REASON_CASE}
        ELSE 'credential_expired'
      END,
      payload_ciphertext = NULL, completed_at = $1,
      lease_owner = NULL, lease_expires_at = NULL,
      organization_id = NULL, inviter_id = NULL
  WHERE status = 'queued'
    AND kind = ANY($3::text[])
    AND created_at <= $2
    AND (lease_owner IS NULL
         OR lease_expires_at IS NULL
         OR lease_expires_at <= $1)
  RETURNING id, kind, status,
            payload_ciphertext AS "payloadCiphertext", attempts,
            last_attempt_at AS "lastAttemptAt",
            last_error_code AS "lastErrorCode",
            cancel_reason AS "cancelReason",
            created_at AS "createdAt", completed_at AS "completedAt"
`;

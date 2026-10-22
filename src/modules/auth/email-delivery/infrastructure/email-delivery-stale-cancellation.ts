/**
 * Removes queued rows of the given kinds created at or before the cutoff the
 * caller chose for them. Credential-bearing kinds are expired; notices have no
 * credential and are not actionable. Both paths erase the queued payload.
 * A row still under a live lease is left to the instance that holds it.
 */
export const CANCEL_STALE_EMAIL_DELIVERY_REQUESTS_SQL = `
  UPDATE email_delivery_requests
  SET status = 'cancelled',
      cancel_reason = CASE
        WHEN kind IN ('mfa_enabled_notification', 'mfa_removed_notification',
                      'api_key_near_expiry_notification')
          THEN 'not_actionable'
        ELSE 'credential_expired'
      END,
      payload_ciphertext = NULL, completed_at = $1,
      lease_owner = NULL, lease_expires_at = NULL,
      organization_id = NULL, inviter_id = NULL
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

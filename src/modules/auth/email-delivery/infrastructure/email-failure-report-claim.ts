import { AppError } from '@/common/errors/app-error';
import type {
  ClaimedFailureReport,
  EmailDeliveryRequestRecord,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';

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
export const CLAIM_UNREPORTED_FAILURES_SQL = `
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
            created_at AS "createdAt", completed_at AS "completedAt",
            failure_notify_lease_expires_at AS "claim"
`;

/**
 * The claim each row was returned with, which is the lease expiry the claim
 * wrote. It identifies the claim (#989): acknowledging and releasing require it,
 * so a row without a readable one is refused rather than given an invented one.
 */
export function withFailureClaims(
  rows: readonly Record<string, unknown>[],
  records: readonly EmailDeliveryRequestRecord[],
): readonly ClaimedFailureReport[] {
  const claims = new Map(rows.map((row) => [row.id, row.claim]));
  return records.map((record) => {
    const claim = claims.get(record.id);
    if (!(claim instanceof Date) || Number.isNaN(claim.getTime())) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Email delivery failure claim is invalid',
        retryable: false,
      });
    }
    return { ...record, claim };
  });
}

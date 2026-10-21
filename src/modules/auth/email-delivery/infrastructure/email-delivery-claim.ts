import type {
  ClaimEmailDeliveryRequestsInput,
  EmailDeliveryKind,
  EmailDeliveryRequestRecord,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EMAIL_DELIVERY_KINDS } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  type AuthRepositoryClient,
  type AuthSqlClient,
  authQueryRows,
  authTransaction,
} from '@/modules/auth/shared/infrastructure/auth-prisma';

const EMAIL_OUTBOX_CLAIM_LOCK = 'auth-email-outbox-claim';

const CLAIM_SQL = `
  WITH eligible AS (
    SELECT id, kind, created_at, organization_id, inviter_id,
           CASE kind
             WHEN 'password_reset_email' THEN 0
             WHEN 'verification_email' THEN 1
             WHEN 'mfa_enabled_notification' THEN 2
             WHEN 'mfa_removed_notification' THEN 2
             WHEN 'organization_invite_email' THEN 3
             ELSE 4
           END AS priority
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
  ),
  invitation_groups AS (
    SELECT count(DISTINCT organization_id)
             + CASE WHEN bool_or(organization_id IS NULL) THEN 1 ELSE 0 END
             AS organization_count,
           count(DISTINCT inviter_id)
             + CASE WHEN bool_or(inviter_id IS NULL) THEN 1 ELSE 0 END
             AS inviter_count
    FROM eligible
    WHERE kind = 'organization_invite_email'
  ),
  ranked AS (
    SELECT eligible.*,
           row_number() OVER (
             PARTITION BY organization_id ORDER BY created_at, id
           ) AS organization_rank,
           row_number() OVER (
             PARTITION BY inviter_id ORDER BY created_at, id
           ) AS inviter_rank
    FROM eligible
    WHERE kind = 'organization_invite_email'
  ),
  fair_candidates AS (
    SELECT eligible.id, eligible.priority, eligible.created_at
    FROM eligible
    WHERE eligible.kind <> 'organization_invite_email'
    UNION ALL
    SELECT ranked.id, ranked.priority, ranked.created_at
    FROM ranked
    CROSS JOIN invitation_groups
    WHERE (invitation_groups.organization_count <= 1
           OR ranked.organization_rank <= 5)
      AND (invitation_groups.inviter_count <= 1
           OR ranked.inviter_rank <= 5)
  ),
  fair_candidate_count AS (
    SELECT count(*) AS candidate_count FROM fair_candidates
  ),
  overflow_candidates AS (
    SELECT ranked.id, ranked.priority, ranked.created_at
    FROM ranked
    CROSS JOIN invitation_groups
    CROSS JOIN fair_candidate_count
    WHERE fair_candidate_count.candidate_count < $2
      AND ((invitation_groups.organization_count > 1
            AND ranked.organization_rank > 5)
           OR (invitation_groups.inviter_count > 1
               AND ranked.inviter_rank > 5))
      AND (invitation_groups.organization_count <= 1
           OR ranked.organization_rank <= 5
           OR NOT EXISTS (
             SELECT 1 FROM ranked other
             WHERE other.organization_rank > 5
               AND other.organization_id IS DISTINCT FROM ranked.organization_id
           ))
      AND (invitation_groups.inviter_count <= 1
           OR ranked.inviter_rank <= 5
           OR NOT EXISTS (
             SELECT 1 FROM ranked other
             WHERE other.inviter_rank > 5
               AND other.inviter_id IS DISTINCT FROM ranked.inviter_id
           ))
  ),
  claim_candidates AS (
    SELECT id, priority, created_at, 0 AS candidate_tier FROM fair_candidates
    UNION ALL
    SELECT id, priority, created_at, 1 AS candidate_tier
    FROM overflow_candidates
  ),
  claimable AS (
    SELECT request.id
    FROM email_delivery_requests request
    JOIN claim_candidates candidate ON candidate.id = request.id
    ORDER BY candidate.priority, candidate.candidate_tier,
             candidate.created_at, candidate.id
    LIMIT $2
    FOR UPDATE OF request SKIP LOCKED
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

async function claimEmailDeliveryRequestsInTransaction(
  client: AuthSqlClient,
  input: ClaimEmailDeliveryRequestsInput,
  toKnownRecords: (
    rows: readonly Record<string, unknown>[],
  ) => readonly EmailDeliveryRequestRecord[],
): Promise<readonly EmailDeliveryRequestRecord[]> {
  const rows = await authQueryRows(client, CLAIM_SQL, [
    input.now,
    input.limit,
    input.owner,
    String(input.leaseMs),
    EMAIL_DELIVERY_KINDS,
  ]);
  const priority = (kind: EmailDeliveryKind): number => {
    switch (kind) {
      case 'password_reset_email':
        return 0;
      case 'verification_email':
        return 1;
      case 'mfa_enabled_notification':
      case 'mfa_removed_notification':
        return 2;
      case 'organization_invite_email':
        return 3;
    }
  };
  return [...toKnownRecords(rows)].sort(
    (left, right) =>
      priority(left.kind) - priority(right.kind) ||
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id),
  );
}

export function claimEmailDeliveryRequests(
  client: AuthRepositoryClient,
  input: ClaimEmailDeliveryRequestsInput,
  toKnownRecords: (
    rows: readonly Record<string, unknown>[],
  ) => readonly EmailDeliveryRequestRecord[],
): Promise<readonly EmailDeliveryRequestRecord[]> {
  return authTransaction(client, async (transaction) => {
    // Re-rank after earlier claim leases commit so SKIP LOCKED cannot consume a group's share.
    await authQueryRows(
      transaction,
      `WITH claim_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
       )
       SELECT 1 FROM claim_lock`,
      [EMAIL_OUTBOX_CLAIM_LOCK],
    );
    return claimEmailDeliveryRequestsInTransaction(
      transaction,
      input,
      toKnownRecords,
    );
  });
}

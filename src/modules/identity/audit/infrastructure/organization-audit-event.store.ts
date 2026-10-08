import { Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';

import {
  type OrganizationAuditDraft,
  type OrganizationAuditStamp,
  organizationAuditEvent,
} from '@/modules/identity/domain/organization-audit-event';

import type { PostgresIdentityQueryClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

/**
 * The part of an event every mutation stamps the same way. `occurredAt` stays
 * explicit because each boundary has its own instant: the clock a key mutation
 * already decides against, or the request's own moment.
 */
export function auditStamp(
  input: {
    readonly context: { readonly requestId: string };
    readonly organizationId: string;
  },
  actorUserAccountId: string,
  occurredAt: Date,
): Omit<OrganizationAuditStamp, 'id'> {
  return {
    organizationId: input.organizationId,
    actorUserAccountId,
    requestId: input.context.requestId,
    occurredAt,
  };
}

const logger = new Logger('OrganizationAuditEvent');

export const INSERT_ORGANIZATION_AUDIT_EVENT_SQL = `
  INSERT INTO organization_audit_events (
    id, organization_id, actor_user_account_id, action, outcome,
    target_type, target_id, target_label, detail, request_id, occurred_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;

/**
 * IDs minted for one instant sort in mint order within this process. The read
 * path still sorts and cursors on both `occurred_at` and `id`; this local order
 * is only a deterministic tie-break for events minted by the same process.
 *
 * The factory is what makes that true. A plain `ulid(t)` randomises everything
 * after the millisecond prefix, so two events stamped with one instant — a
 * denial recorded beside the mutation that refused it, or any pair written
 * inside a single request — would sort against each other at random. The
 * monotonic factory increments instead. It holds within a process; separate
 * instances writing in the same millisecond have no defined relative order.
 */
const nextUlid = monotonicFactory();

export function organizationAuditEventId(occurredAt: Date): string {
  return `oae_${nextUlid(occurredAt.getTime())}`;
}

function createOrganizationAuditEvent(
  stamp: Omit<OrganizationAuditStamp, 'id'>,
  draft: OrganizationAuditDraft,
) {
  return organizationAuditEvent(
    { ...stamp, id: organizationAuditEventId(stamp.occurredAt) },
    draft,
  );
}

export function organizationAuditEventInsertSql(
  stamp: Omit<OrganizationAuditStamp, 'id'>,
  draft: OrganizationAuditDraft,
): SQL {
  const event = createOrganizationAuditEvent(stamp, draft);
  return sql`
    INSERT INTO organization_audit_events (
      id, organization_id, actor_user_account_id, action, outcome,
      target_type, target_id, target_label, detail, request_id, occurred_at
    ) VALUES (
      ${event.id}, ${event.organizationId}, ${event.actorUserAccountId},
      ${event.action}, ${event.outcome}, ${event.targetType}, ${event.targetId},
      ${event.targetLabel}, ${JSON.stringify(event.detail)}, ${event.requestId},
      ${event.occurredAt}
    )
  `;
}

/**
 * Writes one Organization Audit Event through whatever client it is given.
 *
 * On the mutation path that client is the mutation's own transaction, so a
 * failure here fails the mutation: the system refuses to commit state it
 * cannot account for.
 */
export async function recordOrganizationAuditEvent(
  client: PostgresIdentityQueryClient,
  stamp: Omit<OrganizationAuditStamp, 'id'>,
  draft: OrganizationAuditDraft,
): Promise<void> {
  const event = createOrganizationAuditEvent(stamp, draft);

  await client.query(INSERT_ORGANIZATION_AUDIT_EVENT_SQL, [
    event.id,
    event.organizationId,
    event.actorUserAccountId,
    event.action,
    event.outcome,
    event.targetType,
    event.targetId,
    event.targetLabel,
    JSON.stringify(event.detail),
    event.requestId,
    event.occurredAt,
  ]);
}

/**
 * Writes a refused attempt, outside any transaction because the transaction
 * that refused it has rolled back.
 *
 * Failure is swallowed deliberately, against the mutation path's rule. A
 * committed mutation with no trace loses evidence that state changed; an
 * unrecorded refusal loses a signal about a change that never happened.
 * Failing the request here would let an audit outage become an authorization
 * outage, which is the worse failure of the two.
 */
export async function recordOrganizationAuditDenial(
  client: PostgresIdentityQueryClient,
  stamp: Omit<OrganizationAuditStamp, 'id'>,
  draft: OrganizationAuditDraft,
): Promise<void> {
  try {
    await recordOrganizationAuditEvent(client, stamp, draft);
  } catch {
    logger.error({
      message: 'Organization audit denial was not recorded',
      organizationId: stamp.organizationId,
      action: draft.action,
      requestId: stamp.requestId,
    });
  }
}

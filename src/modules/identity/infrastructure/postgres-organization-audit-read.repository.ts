import {
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_AUDIT_OUTCOMES,
} from '../../../contracts/organization/audit-event';
import type {
  ListOrganizationAuditEventsInput,
  OrganizationAuditEventReadPort,
  OrganizationAuditEventRecord,
} from '../application/organization-audit-event-read.port';
import type {
  OrganizationAuditAction,
  OrganizationAuditOutcome,
  OrganizationAuditTargetType,
} from '../domain/organization-audit-event';

import { identityStoreError, isRecord, stringValue } from './identity-row';
import type { PostgresIdentityQueryClient } from './postgres-identity.client';

const TARGET_TYPES = ['membership', 'invitation', 'api_key'] as const;

/**
 * Keyset rather than offset: the trail grows while a reader pages through it,
 * and an offset page shifts under them. `(occurred_at, id)` is a total order
 * because ids are unique, so the pair is both the sort and the cursor.
 *
 * The ordering is declared on both columns rather than on the id alone. The
 * id's time prefix does currently equal `occurred_at`, but leaning on that
 * would couple this query to how ids are generated — an assumption this table
 * has already had corrected once.
 *
 * `$2` and `$3` are the cursor position and `$4` the effective filter mask,
 * shaped so one prepared statement serves a paged and an unpaged read. The
 * join to `user_accounts` is inner: the actor column is `NOT NULL` with a
 * restricting key, so a missing row is a broken projection, not an absence.
 */
const LIST_AUDIT_EVENTS_SQL = `
  SELECT
    event.id,
    event.action,
    event.outcome,
    event.target_type,
    event.target_label,
    event.detail,
    actor.username AS actor_username,
    event.request_id,
    event.occurred_at
  FROM organization_audit_events AS event
  JOIN user_accounts AS actor
    ON actor.id = event.actor_user_account_id
  WHERE event.organization_id = $1
    AND ($2::timestamptz IS NULL OR (event.occurred_at, event.id) < ($2, $3))
    AND ($4::text[] IS NULL OR event.action = ANY($4))
    AND ($5::text IS NULL OR event.outcome = $5)
    AND ($6::timestamptz IS NULL OR event.occurred_at >= $6)
    AND ($7::timestamptz IS NULL OR event.occurred_at < $7)
  ORDER BY event.occurred_at DESC, event.id DESC
  LIMIT $8
`;

/**
 * These three lookups are also where the published vocabulary and the domain
 * unions are held to the same sets. Each narrows a contract array into a
 * domain type, so an Audit action present in one and missing from the other
 * fails to compile here rather than returning `undefined` for a real row and
 * failing a whole page at runtime. No separate assertion is needed for that.
 */
function actionValue(
  record: Record<string, unknown>,
): OrganizationAuditAction | undefined {
  const value = record.action;
  return ORGANIZATION_AUDIT_ACTIONS.find((action) => action === value);
}

function outcomeValue(
  record: Record<string, unknown>,
): OrganizationAuditOutcome | undefined {
  const value = record.outcome;
  return ORGANIZATION_AUDIT_OUTCOMES.find((outcome) => outcome === value);
}

function targetTypeValue(
  record: Record<string, unknown>,
): OrganizationAuditTargetType | undefined {
  const value = record.target_type;
  return TARGET_TYPES.find((targetType) => targetType === value);
}

function dateValue(
  record: Record<string, unknown>,
  key: string,
): Date | undefined {
  const value = record[key];
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function mapAuditEvent(
  value: unknown,
): OrganizationAuditEventRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = stringValue(value, 'id');
  const action = actionValue(value);
  const outcome = outcomeValue(value);
  const targetType = targetTypeValue(value);
  const actorUsername = stringValue(value, 'actor_username');
  const requestId = stringValue(value, 'request_id');
  const occurredAt = dateValue(value, 'occurred_at');

  if (
    id === undefined ||
    action === undefined ||
    outcome === undefined ||
    targetType === undefined ||
    actorUsername === undefined ||
    requestId === undefined ||
    occurredAt === undefined
  ) {
    return undefined;
  }

  // A redacted label is absent, not broken: the event still stands and is
  // still returned, which is the difference between an erasure and a deletion.
  const rawLabel = value.target_label;
  if (rawLabel !== null && typeof rawLabel !== 'string') {
    return undefined;
  }

  const rawDetail = value.detail;
  if (rawDetail !== null && !isRecord(rawDetail)) {
    return undefined;
  }

  return {
    id,
    action,
    outcome,
    targetType,
    targetLabel: rawLabel,
    detail: rawDetail ?? {},
    actorUsername,
    requestId,
    occurredAt,
  };
}

/**
 * Deliberately separate from the audit event store beside it. That store is a
 * write helper that runs inside transactions other repositories open; this
 * read owns its own client and has no transaction to join.
 */
export class PostgresOrganizationAuditReadRepository
  implements OrganizationAuditEventReadPort
{
  constructor(private readonly client: PostgresIdentityQueryClient) {}

  async listAuditEvents(
    input: ListOrganizationAuditEventsInput,
  ): Promise<readonly OrganizationAuditEventRecord[]> {
    if (
      input.context.organizationId !== input.organizationId ||
      input.organizationId.trim().length === 0 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1
    ) {
      throw identityStoreError('Identity organization audit input is invalid');
    }

    const { filter, after } = input;

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(LIST_AUDIT_EVENTS_SQL, [
        input.organizationId,
        after?.occurredAt ?? null,
        after?.id ?? null,
        filter.actions === undefined ? null : [...filter.actions],
        filter.outcome ?? null,
        filter.from ?? null,
        filter.to ?? null,
        input.limit,
      ]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }

    const events: OrganizationAuditEventRecord[] = [];
    for (const row of rows) {
      const event = mapAuditEvent(row);
      // A broken projection fails the whole page rather than dropping one
      // event, the same way the open-invitation listing refuses to return
      // partial metadata. A trail with a silent hole is worse than an error.
      if (event === undefined) {
        throw identityStoreError('Identity data is invalid');
      }
      events.push(event);
    }

    return events;
  }
}

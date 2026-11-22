import { isRecord } from '@/common/is-record';
import type {
  OrganizationAuditEventFilter,
  OrganizationAuditEventPosition,
} from '@/modules/identity/audit/application/organization-audit-event-read.port';
import {
  computeScopeHash,
  encodeCursor,
  tryDecodeCursor,
} from '@/modules/identity/shared/presentation/cursor-codec';

/** The version the audit trail wrote before it moved to the shared codec. */
const LEGACY_CURSOR_VERSION = 1;

/** The shape migration 0011 constrains `organization_audit_events.id` to. */
const AUDIT_EVENT_ID = /^oae_[0-9A-HJKMNP-TV-Z]{26}$/;

interface AuditCursorPosition {
  readonly occurredAt: string;
  readonly id: string;
}

export function auditFilterHash(filter: OrganizationAuditEventFilter): string {
  return computeScopeHash(auditScope(filter));
}

function auditScope(filter: OrganizationAuditEventFilter): {
  readonly actions: readonly string[] | null;
  readonly outcome: string | null;
  readonly from: string | null;
  readonly to: string | null;
} {
  return {
    actions: filter.actions === undefined ? null : [...filter.actions].sort(),
    outcome: filter.outcome ?? null,
    from: filter.from === undefined ? null : filter.from.toISOString(),
    to: filter.to === undefined ? null : filter.to.toISOString(),
  };
}

export function encodeAuditCursor(
  position: OrganizationAuditEventPosition,
  filter: OrganizationAuditEventFilter,
): string {
  return encodeCursor(
    { occurredAt: position.occurredAt.toISOString(), id: position.id },
    auditScope(filter),
  );
}

/**
 * Returns the position, or `undefined` for every way a cursor can be
 * unusable: malformed, a version this build does not know, or minted against a
 * different filter. All three have the same recovery — drop it and read from
 * the start — so the caller answers them identically.
 */
export function decodeAuditCursor(
  raw: string,
  filter: OrganizationAuditEventFilter,
): OrganizationAuditEventPosition | undefined {
  const current = tryDecodeCursor(raw, auditScope(filter), isAuditPosition);
  if (current.kind === 'ok') {
    const moment = new Date(current.position.occurredAt);
    if (Number.isNaN(moment.getTime())) {
      return undefined;
    }
    return { occurredAt: moment, id: current.position.id };
  }

  // Cursors issued before the shared codec carry the audit filter hash in `f`
  // and the position at the top level. Keep reading them until they age out.
  return decodeLegacyAuditCursor(raw, filter);
}

function isAuditPosition(value: unknown): value is AuditCursorPosition {
  if (!isRecord(value)) {
    return false;
  }

  const { occurredAt, id } = value;
  // The id reaches SQL; a value that is not an event id must stop here, not as
  // a database error.
  return (
    typeof occurredAt === 'string' &&
    typeof id === 'string' &&
    AUDIT_EVENT_ID.test(id)
  );
}

function decodeLegacyAuditCursor(
  raw: string,
  filter: OrganizationAuditEventFilter,
): OrganizationAuditEventPosition | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const { v, occurredAt, id, f } = parsed;
  if (
    v !== LEGACY_CURSOR_VERSION ||
    typeof occurredAt !== 'string' ||
    typeof id !== 'string' ||
    !AUDIT_EVENT_ID.test(id) ||
    typeof f !== 'string' ||
    f !== auditFilterHash(filter)
  ) {
    return undefined;
  }

  const moment = new Date(occurredAt);
  if (Number.isNaN(moment.getTime())) {
    return undefined;
  }

  return { occurredAt: moment, id };
}

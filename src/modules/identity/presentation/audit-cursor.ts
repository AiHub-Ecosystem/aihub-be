import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../common/serialization/canonical-json';
import type {
  OrganizationAuditEventFilter,
  OrganizationAuditEventPosition,
} from '../application/organization-audit-event-read.port';

/**
 * Bumped when the payload shape changes, so a cursor minted by an older
 * deployment fails loudly instead of decoding into something plausible.
 */
const CURSOR_VERSION = 1;

/**
 * Enough to notice a filter that changed under a cursor; this is not a forgery
 * control. The cursor carries no authority — every position it names is still
 * bounded by the caller's Organization in the query itself.
 */
const FILTER_HASH_LENGTH = 16;

interface CursorPayload {
  readonly v: number;
  readonly occurredAt: string;
  readonly id: string;
  readonly f: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Uses the shared canonical serializer, so the codebase keeps one answer to
 * "turn an object into a stable string". Sorting the actions matters: the same
 * filter typed in a different order is the same filter.
 */
export function auditFilterHash(filter: OrganizationAuditEventFilter): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        actions:
          filter.actions === undefined ? null : [...filter.actions].sort(),
        outcome: filter.outcome ?? null,
        from: filter.from === undefined ? null : filter.from.toISOString(),
        to: filter.to === undefined ? null : filter.to.toISOString(),
      }),
    )
    .digest('hex')
    .slice(0, FILTER_HASH_LENGTH);
}

export function encodeAuditCursor(
  position: OrganizationAuditEventPosition,
  filter: OrganizationAuditEventFilter,
): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    occurredAt: position.occurredAt.toISOString(),
    id: position.id,
    f: auditFilterHash(filter),
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
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
    v !== CURSOR_VERSION ||
    typeof occurredAt !== 'string' ||
    typeof id !== 'string' ||
    typeof f !== 'string'
  ) {
    return undefined;
  }

  if (f !== auditFilterHash(filter)) {
    return undefined;
  }

  const moment = new Date(occurredAt);
  if (Number.isNaN(moment.getTime())) {
    return undefined;
  }

  return { occurredAt: moment, id };
}

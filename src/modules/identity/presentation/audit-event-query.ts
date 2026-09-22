import { invalidRequest } from '../../../common/errors/invalid-request';
import { parseUtcTimestamp } from '../../../common/time/parse-utc-timestamp';
import {
  DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE,
  MAX_ORGANIZATION_AUDIT_PAGE_SIZE,
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_AUDIT_OUTCOMES,
} from '../../../contracts/organization/audit-event';
import type {
  OrganizationAuditEventFilter,
  OrganizationAuditEventPosition,
} from '../application/organization-audit-event-read.port';

import { decodeAuditCursor } from './audit-cursor';

export interface OrganizationAuditQuery {
  readonly filter: OrganizationAuditEventFilter;
  readonly after?: OrganizationAuditEventPosition;
  readonly limit: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A repeated key arrives as an array and a single one as a string, because the
 * default query parser reflects arity rather than declared shape. Both are the
 * same filter with one or many values.
 */
function parseActions(
  value: unknown,
): OrganizationAuditEventFilter['actions'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) {
    return undefined;
  }

  const actions = raw.map((entry) => {
    const found = ORGANIZATION_AUDIT_ACTIONS.find((action) => action === entry);
    if (found === undefined) {
      // An unknown action is a typo, not an empty filter: answering with an
      // empty page would read as "nothing happened".
      throw invalidRequest();
    }
    return found;
  });

  return actions;
}

function parseOutcome(
  value: unknown,
): OrganizationAuditEventFilter['outcome'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const outcome = ORGANIZATION_AUDIT_OUTCOMES.find((known) => known === value);
  if (outcome === undefined) {
    throw invalidRequest();
  }
  return outcome;
}

function parseBound(value: unknown): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidRequest();
  }

  const parsed = parseUtcTimestamp(value);
  if (parsed === undefined) {
    throw invalidRequest();
  }
  return parsed;
}

/**
 * Out of range is refused rather than clamped. A silently reduced page is
 * indistinguishable from the end of the trail, which is the one thing an audit
 * read must never blur.
 */
function parseLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw invalidRequest();
  }

  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > MAX_ORGANIZATION_AUDIT_PAGE_SIZE) {
    throw invalidRequest();
  }
  return limit;
}

/**
 * Parsed by hand rather than by the canonical TypeBox schema the mutation
 * bodies use: a query string is stringly-typed, so a page size arrives as text
 * and an action arrives as a string or an array, and a schema check alone
 * would reject all of it without a coercion layer this codebase does not have.
 * The response schema stays in the contracts module as it does everywhere.
 */
export function parseOrganizationAuditQuery(
  raw: unknown,
): OrganizationAuditQuery {
  const query = isRecord(raw) ? raw : {};

  const actions = parseActions(query.action);
  const outcome = parseOutcome(query.outcome);
  const from = parseBound(query.from);
  const to = parseBound(query.to);

  if (
    from !== undefined &&
    to !== undefined &&
    from.getTime() >= to.getTime()
  ) {
    throw invalidRequest();
  }

  const filter: OrganizationAuditEventFilter = {
    ...(actions === undefined ? {} : { actions }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };

  const limit = parseLimit(query.limit);

  if (query.cursor === undefined) {
    return { filter, limit };
  }
  if (typeof query.cursor !== 'string') {
    throw invalidRequest();
  }

  const after = decodeAuditCursor(query.cursor, filter);
  if (after === undefined) {
    throw invalidRequest();
  }

  return { filter, after, limit };
}

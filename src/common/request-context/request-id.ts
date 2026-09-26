import { monotonicFactory } from 'ulid';

/**
 * Prefixed ULIDs, per the D1 request-id contract: `req_01JXYZ...`.
 *
 * ULID over UUID because request ids are also the primary key of
 * `usage_records`; being time-sortable keeps index writes local instead of
 * scattering them across the B-tree.
 *
 * The monotonic factory preserves mint order for calls in this process that
 * share a millisecond. It does not establish order across processes.
 */
const nextUlid = monotonicFactory();

export const REQUEST_ID_PREFIX = 'req_';

export function generateRequestId(): string {
  return `${REQUEST_ID_PREFIX}${nextUlid()}`;
}

export function isRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(REQUEST_ID_PREFIX) &&
    value.length === REQUEST_ID_PREFIX.length + 26
  );
}

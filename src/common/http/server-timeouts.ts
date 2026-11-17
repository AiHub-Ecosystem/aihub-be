import { OPERATION_CATALOG } from '@/catalog/operation-catalog';

// #392 fixes one transport-wide receive bound, so the catalog is the source
// for the operations this listener serves, not Speaking-specific policy.
const LONGEST_ROUTE_DEADLINE_MS = Math.max(
  ...Object.values(OPERATION_CATALOG).map((operation) => operation.timeoutMs),
);
const LARGEST_UPLOAD_BYTES = Math.max(
  ...Object.values(OPERATION_CATALOG)
    .filter(
      (operation) =>
        'contentType' in operation &&
        operation.contentType === 'multipart/form-data',
    )
    .map((operation) => operation.maxBodyBytes),
);
const MIN_UPLOAD_BYTES_PER_SECOND = 500;
const CONNECTION_IDLE_TIMEOUT_MS = 60_000;

// Fastify's requestTimeout is zero by default. It bounds receiving the whole
// request, so the full-size upload gets the largest catalog deadline plus its
// wire time at the stated 500 B/s floor: 125,000 ms + 54,525,952 ms =
// 54,650,952 ms.
export const REQUEST_TIMEOUT_MS =
  LONGEST_ROUTE_DEADLINE_MS +
  Math.ceil((LARGEST_UPLOAD_BYTES * 1_000) / MIN_UPLOAD_BYTES_PER_SECOND);

export const CONNECTION_TIMEOUT_MS = CONNECTION_IDLE_TIMEOUT_MS;

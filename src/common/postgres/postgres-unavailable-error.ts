const ADAPTER_CONNECTION_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
]);

// P1001 unreachable, P1002 timed out, P1017 closed, P2024 pool timeout.
const PRISMA_CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1017', 'P2024']);

// admin_shutdown, crash_shutdown, cannot_connect_now; class 08 is checked apart.
const SERVER_UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03']);

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

// The messages node-postgres uses for a lost or unanswered connection.
const PG_CONNECTION_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Query read timeout',
];

/**
 * Whether an error means Postgres could not be reached or stopped answering,
 * as opposed to rejecting a statement. A bare socket code counts only inside a
 * Prisma or driver-adapter error, so another dependency's network failure is
 * never reported as a database outage.
 */
export function isPostgresUnavailable(error: unknown): boolean {
  const pending: { readonly value: unknown; readonly wrapped: boolean }[] = [
    { value: error, wrapped: false },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const candidate = next.value;
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const record = candidate as Record<string, unknown>;
    const code = record.code ?? record.originalCode;
    const message = record.message ?? record.originalMessage;
    if (
      (typeof record.kind === 'string' &&
        ADAPTER_CONNECTION_KINDS.has(record.kind)) ||
      (typeof code === 'string' &&
        (PRISMA_CONNECTION_CODES.has(code) ||
          SERVER_UNAVAILABLE_SQLSTATES.has(code) ||
          /^08[0-9A-Z]{3}$/.test(code) ||
          (next.wrapped && NETWORK_CODES.has(code)))) ||
      (typeof message === 'string' &&
        PG_CONNECTION_MESSAGES.some((text) => message.includes(text)))
    ) {
      return true;
    }

    const name = candidate instanceof Error ? candidate.name : '';
    const wrapped =
      next.wrapped ||
      name.startsWith('PrismaClient') ||
      name === 'DriverAdapterError';
    for (const key of ['cause', 'meta', 'driverAdapterError']) {
      if (record[key] !== undefined) {
        pending.push({
          value: record[key],
          wrapped: wrapped || key === 'driverAdapterError',
        });
      }
    }
  }

  return false;
}

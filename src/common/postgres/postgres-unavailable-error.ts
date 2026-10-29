import { AppError } from '@/common/errors/app-error';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';

import { findPostgresErrorLink } from './postgres-error-chain';

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

// The messages node-postgres uses for a lost or unanswered connection, and
// Prisma's for a transaction that never got a connection (P2028).
const PG_CONNECTION_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Query read timeout',
  'Unable to start a transaction in the given time',
];

/**
 * Whether an error means Postgres could not be reached or stopped answering,
 * as opposed to rejecting a statement. A bare socket code counts only inside a
 * Prisma or driver-adapter error, so another dependency's network failure is
 * never reported as a database outage.
 */
export function isPostgresUnavailable(error: unknown): boolean {
  return (
    findPostgresErrorLink(
      error,
      ({ code, message, kind, wrapped }) =>
        (typeof kind === 'string' && ADAPTER_CONNECTION_KINDS.has(kind)) ||
        (typeof code === 'string' &&
          (PRISMA_CONNECTION_CODES.has(code) ||
            SERVER_UNAVAILABLE_SQLSTATES.has(code) ||
            /^08[0-9A-Z]{3}$/.test(code) ||
            (wrapped && NETWORK_CODES.has(code)))) ||
        (typeof message === 'string' &&
          PG_CONNECTION_MESSAGES.some((text) => message.includes(text))),
    ) !== undefined
  );
}

/** The one answer for a database outage or timeout (ADR-0118). */
export function databaseUnavailableError(
  cause?: unknown,
  message = 'Database temporarily unavailable',
): AppError {
  return new AppError({
    code: 'DATABASE_UNAVAILABLE',
    message,
    retryable: true,
    retryAfterMs: outageRetryAfterMs(),
    ...(cause === undefined ? {} : { cause }),
  });
}

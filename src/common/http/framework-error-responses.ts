import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';

import type {
  ConnectionError,
  FastifyBaseLogger,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from 'fastify';

import {
  type ErrorEnvelope,
  createErrorEnvelope,
} from '@/common/errors/error-envelope';
import { generateRequestId } from '@/common/request-context/request-id';
import { recordRequestFailure } from './request-failure.recorder';
import { BASELINE_CONTENT_SECURITY_POLICY } from './security-headers.hook';

/**
 * The router's own rejections and the HTTP parser's own rejections both happen
 * before Nest dispatches and before Fastify runs any hook: `onRequest`,
 * `onSend`, and `onResponse` are skipped. The security headers, the
 * `X-Request-Id` header, and the Request Completion Event those hooks would
 * write are written here instead.
 *
 * Answers carry the AIHUB envelope so no `FST_ERR_*` code, framework status
 * text, or caller-supplied path reaches the client.
 */

export type RequestCompletionWriter = (
  log: FastifyBaseLogger,
  request: FastifyRequest,
  reply: FastifyReply,
) => void;

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Content-Security-Policy', BASELINE_CONTENT_SECURITY_POLICY],
  ['X-Frame-Options', 'DENY'],
];

/** A malformed percent escape in the path, rejected by the router. */
export function badUrlEnvelope(requestId: string): ErrorEnvelope {
  return createErrorEnvelope({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    requestId,
    retryable: false,
  });
}

/**
 * `FST_ERR_ASYNC_CONSTRAINT` cannot be raised by this application: it needs an
 * async route constraint, and the only constraint installed is the version
 * constraint Nest adds, whose `storage()` is synchronous. Should one ever
 * appear, it is answered like a bad URL rather than escaping as a raw body.
 */
export function frameworkErrorResponse(
  writeCompletion: RequestCompletionWriter,
  log: FastifyBaseLogger,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = String(request.id);
  recordRequestFailure(request, 'INVALID_REQUEST');
  reply.code(400);
  for (const [name, value] of SECURITY_HEADERS) {
    reply.header(name, value);
  }
  reply.header('X-Request-Id', requestId);
  reply.send(badUrlEnvelope(requestId));
  writeCompletion(log, request, reply);
}

/**
 * Parser rejections happen before there is a Fastify request, so there is no
 * request id from `genReqId` and no completion event to write. Both 431 and
 * 408 map to `INVALID_REQUEST`: they are caller faults with no public code of
 * their own, and adding one would break the Customer Web contract until the
 * frontend lists it. The status still says which fault it was.
 */
function clientErrorEnvelope(
  error: ConnectionError,
  requestId: string,
): { readonly status: number; readonly envelope: ErrorEnvelope } {
  if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
    return {
      status: 408,
      envelope: createErrorEnvelope({
        code: 'INVALID_REQUEST',
        message: 'Request timed out',
        requestId,
        retryable: false,
      }),
    };
  }
  if (
    error.code === 'HPE_HEADER_OVERFLOW' ||
    error.code === 'HPE_HEADERS_TOO_LARGE'
  ) {
    return {
      status: 431,
      envelope: createErrorEnvelope({
        code: 'INVALID_REQUEST',
        message: 'Request headers too large',
        requestId,
        retryable: false,
      }),
    };
  }
  return { status: 400, envelope: badUrlEnvelope(requestId) };
}

export function clientErrorResponse(
  error: ConnectionError,
  socket: Socket,
): void {
  // Same early exit as Fastify's default: a reset socket has no response to send.
  if (error.code === 'ECONNRESET' || socket.destroyed) {
    return;
  }

  const { status, envelope } = clientErrorEnvelope(error, generateRequestId());
  const body = JSON.stringify(envelope);
  const head = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    ...SECURITY_HEADERS.map(([name, value]) => `${name}: ${value}`),
    `X-Request-Id: ${envelope.error.request_id}`,
  ].join('\r\n');

  if (socket.writable) {
    socket.write(`${head}\r\n\r\n${body}`);
  }
  socket.destroy(error);
}

/**
 * One pair of handlers, supplied where the Fastify instance is created. The
 * production bootstrap and the spec that pins these responses both call this
 * factory, so an upgrade cannot change one without the other.
 *
 * The completion writer is passed in: `src/common` must not import a business
 * module, while the event itself belongs to Metering.
 */
export function createAppFastifyErrorOptions(
  writeCompletion: RequestCompletionWriter,
): Pick<FastifyServerOptions, 'frameworkErrors' | 'clientErrorHandler'> {
  return {
    // The error itself is never read: its message repeats the caller's path.
    frameworkErrors: (_error, request, reply) =>
      frameworkErrorResponse(writeCompletion, request.log, request, reply),
    clientErrorHandler: (error, socket) => clientErrorResponse(error, socket),
  };
}

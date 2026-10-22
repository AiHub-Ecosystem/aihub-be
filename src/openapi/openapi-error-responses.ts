import { type TSchema, Type } from '@sinclair/typebox';

import type { ErrorCode } from '@/common/errors/error-code';
import type { HttpStatus } from '@/common/errors/error-registry';

export function errorResponseSchema(codes: readonly ErrorCode[]): TSchema {
  return Type.Object(
    {
      error: Type.Object(
        {
          code: Type.Union(codes.map((code) => Type.Literal(code))),
          message: Type.String(),
          request_id: Type.String(),
          retryable: Type.Boolean(),
          retry_after_ms: Type.Optional(Type.Integer({ minimum: 0 })),
          details: Type.Optional(
            Type.Object({}, { additionalProperties: true }),
          ),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
}

/** Statuses whose errors can carry `retry_after_ms`, and so `Retry-After`. */
const RETRY_HINT_STATUSES: ReadonlySet<HttpStatus> = new Set([409, 429, 503]);

const RETRY_AFTER_HEADER = {
  description:
    'Present whenever the error includes retry_after_ms: the same wait in whole seconds, rounded up.',
  schema: { type: 'string', pattern: '^[0-9]+$' },
};

/** The per-key limit, in draft-ietf-httpapi-ratelimit-headers-11 syntax. */
const RATE_LIMIT_HEADERS = {
  'RateLimit-Policy': {
    description:
      'Advisory. The per-minute limit of the API key, for example `"per-key";q=600;w=60`. Present on routes the per-key limit applies to.',
    schema: { type: 'string' },
  },
  RateLimit: {
    description:
      'Advisory. What the API key has left of its current window and the whole seconds until it resets, for example `"per-key";r=0;t=13`.',
    schema: { type: 'string' },
  },
};

export function buildErrorResponses(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [status, codes] of groupedErrors) {
    responses[`Error${status}`] = {
      description: codes.join(' | '),
      ...(RETRY_HINT_STATUSES.has(status)
        ? {
            headers: {
              'Retry-After': RETRY_AFTER_HEADER,
              ...(status === 429 ? RATE_LIMIT_HEADERS : {}),
            },
          }
        : {}),
      content: {
        'application/json': { schema: errorResponseSchema(codes) },
      },
    };
  }
  responses.AuthRateLimited = {
    description:
      'An authentication rate budget is exhausted. The refusal is the same one on every authentication route, so the response always carries the wait in `retry_after_ms` and, whenever a wait is known, in the `Retry-After` header.',
    headers: {
      'Retry-After': {
        description:
          'Whole seconds to wait before retrying, rounded up from the longest exhausted window.',
        schema: { type: 'string', pattern: '^[0-9]+$' },
      },
    },
    content: {
      'application/json': {
        schema: errorResponseSchema(['RATE_LIMITED']),
      },
    },
  };
  return responses;
}

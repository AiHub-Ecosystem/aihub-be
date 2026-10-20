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

export function buildErrorResponses(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [status, codes] of groupedErrors) {
    responses[`Error${status}`] = {
      description: codes.join(' | '),
      ...(status === 503
        ? {
            headers: {
              'Retry-After': {
                description:
                  'Whole seconds to wait before retrying when the error includes retry_after_ms.',
                schema: { type: 'string', pattern: '^[0-9]+$' },
              },
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

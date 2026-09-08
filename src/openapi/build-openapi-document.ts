import { type TSchema, Type } from '@sinclair/typebox';

import type {
  IdempotencyMode,
  OperationDef,
} from '../catalog/operation-catalog';
import { OPERATION_CATALOG } from '../catalog/operation-catalog';
import { OPERATION_IDS } from '../catalog/operation-id';
import type { OperationId } from '../catalog/operation-id';
import { ERROR_CODES, type ErrorCode } from '../common/errors/error-code';
import {
  type HttpStatus,
  httpStatusForErrorCode,
} from '../common/errors/error-registry';

/**
 * The error registry is the source of truth for status/code groupings. A
 * 409 response remains operation-specific because only idempotent operations
 * can reach an idempotency conflict.
 */
function errorsByStatus(): ReadonlyMap<HttpStatus, readonly ErrorCode[]> {
  const grouped = new Map<HttpStatus, ErrorCode[]>();

  for (const code of ERROR_CODES) {
    const status = httpStatusForErrorCode(code);
    const codes = grouped.get(status);
    if (codes === undefined) {
      grouped.set(status, [code]);
    } else {
      codes.push(code);
    }
  }

  return new Map(
    [...grouped.entries()].sort(([left], [right]) => left - right),
  );
}

const OPENAPI_VERSION = '3.1.0';

function errorResponseSchema(codes: readonly ErrorCode[]): TSchema {
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

/**
 * Mirrors `SuccessEnvelopeInterceptor`'s actual output field for field —
 * `correlation_id` is genuinely optional there (only present when the
 * client sent `X-Correlation-Id`), not merely undocumented.
 */
function successEnvelopeSchema(dataSchema: TSchema): TSchema {
  return Type.Object(
    {
      data: dataSchema,
      meta: Type.Object(
        {
          request_id: Type.String({
            pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
          }),
          correlation_id: Type.Optional(Type.String()),
          service: Type.String(),
          operation: Type.String(),
          timing: Type.Object(
            {
              downstream_ms: Type.Integer({ minimum: 0 }),
              gateway_overhead_ms: Type.Integer({ minimum: 0 }),
              total_ms: Type.Integer({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
}

function idempotencyKeyParameter(
  mode: IdempotencyMode,
): Record<string, unknown> {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required: mode === 'required',
    schema: { type: 'string', minLength: 1, maxLength: 255 },
    description:
      mode === 'required'
        ? 'Required. Trimmed and limited to 1–255 UTF-8 bytes. Scoped to (organization, operation, key); replays the stored result for a repeat call.'
        : mode === 'optional'
          ? 'Optional. This operation may call a model, so a client that wants replay safety should send one.'
          : 'Ignored. This operation never stores or replays an idempotency record.',
  };
}

const CORRELATION_ID_PARAMETER = {
  name: 'X-Correlation-Id',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description:
    "Client-supplied trace id, echoed back in `meta.correlation_id`. Never used as the request's own identity — that is always AIHUB-generated as `meta.request_id`.",
};

const USER_ASSERTION_PARAMETER = {
  name: 'X-User-Assertion',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1 },
  description:
    'Signed organization assertion identifying the end user. Required for user-scoped operations.',
};

function resolvedResponseSchema(
  operationId: OperationId,
  operation: OperationDef,
): TSchema {
  if (operation.responseContract === 'unresolved') {
    // Fails loudly rather than silently embedding the string 'unresolved'
    // as though it were a schema — a broken document is worse than no
    // document, and this is exactly the drift #2 exists to prevent.
    throw new Error(
      `${operationId} has no resolved response contract; cannot generate its OpenAPI schema`,
    );
  }

  return operation.responseContract;
}

function operationToPathItem(
  operationId: OperationId,
  operation: OperationDef,
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const parameters = [
    { $ref: '#/components/parameters/CorrelationId' },
    operation.identityScope === 'user'
      ? { $ref: '#/components/parameters/UserAssertion' }
      : undefined,
    idempotencyKeyParameter(operation.idempotency),
  ].filter((parameter) => parameter !== undefined);

  const responses: Record<string, unknown> = {
    '200': {
      description: 'Success',
      ...(operation.idempotency !== 'none'
        ? {
            headers: {
              'Idempotent-Replay': {
                description:
                  'Present with value true when the completed business result was replayed for this key.',
                schema: { type: 'string', enum: ['true'] },
              },
            },
          }
        : {}),
      content: {
        'application/json': {
          schema: successEnvelopeSchema(
            resolvedResponseSchema(operationId, operation),
          ),
        },
      },
    },
  };

  for (const status of groupedErrors.keys()) {
    if (status === 409 && operation.idempotency === 'none') {
      continue;
    }
    responses[String(status)] = {
      $ref: `#/components/responses/Error${status}`,
    };
  }

  return {
    [operation.method.toLowerCase()]: {
      operationId,
      summary: operationId,
      'x-required-scope': operation.requiredScope,
      'x-identity-scope': operation.identityScope,
      'x-idempotency': operation.idempotency,
      security: [{ ApiKeyAuth: [] }],
      parameters,
      requestBody: {
        required: true,
        content: {
          [operation.contentType]: { schema: operation.requestSchema },
        },
      },
      responses,
    },
  };
}

export function buildOpenApiDocument(version: string): unknown {
  const paths: Record<string, unknown> = {};
  const groupedErrors = errorsByStatus();

  for (const operationId of OPERATION_IDS) {
    const operation = OPERATION_CATALOG[operationId];
    paths[operation.path] = {
      ...(paths[operation.path] as Record<string, unknown> | undefined),
      ...operationToPathItem(operationId, operation, groupedErrors),
    };
  }

  const errorResponses: Record<string, unknown> = {};
  for (const [status, codes] of groupedErrors) {
    errorResponses[`Error${status}`] = {
      description: codes.join(' | '),
      content: {
        'application/json': { schema: errorResponseSchema(codes) },
      },
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'AIHUB Writing API',
      version,
    },
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description:
            'Organization credential. Identifies the organization; does not identify an individual end user.',
        },
      },
      parameters: {
        CorrelationId: CORRELATION_ID_PARAMETER,
        UserAssertion: USER_ASSERTION_PARAMETER,
      },
      responses: errorResponses,
    },
    paths,
  };
}

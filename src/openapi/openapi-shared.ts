import { type TSchema, Type } from '@sinclair/typebox';

import type { CacheControlPolicy } from '@/catalog/openapi-operation-metadata';
import type {
  IdempotencyMode,
  OperationDef,
} from '@/catalog/operation-catalog';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { PublicRouteDef, PublicRouteId } from '@/catalog/public-routes';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { ERROR_CODES, type ErrorCode } from '@/common/errors/error-code';
import {
  type HttpStatus,
  httpStatusForErrorCode,
} from '@/common/errors/error-registry';
import { toOpenApiPath } from './openapi-path';

/**
 * Reads a route's declared data out of the Public API Route registry. A missing
 * schema is a registry error, not a document error: a bodyless route that asks
 * for a schema means the entry and the path item disagree about what it accepts.
 */
export function routeSchemaOf(
  routeId: PublicRouteId,
  kind: 'request' | 'response',
): TSchema {
  const schema = PUBLIC_ROUTES[routeId][`${kind}Schema`];
  if (schema === null) {
    throw new Error(
      `${routeId} declares no ${kind} schema, but its path item published one`,
    );
  }
  return schema;
}

export function routePathOf(routeId: PublicRouteId): string {
  return toOpenApiPath(PUBLIC_ROUTES[routeId].path);
}

export function routeSuccessKeyOf(routeId: PublicRouteId): string {
  return String(PUBLIC_ROUTES[routeId].successStatus);
}

/** The responses for the route's declared alternate success statuses. */
export function routeAlternateSuccessResponsesOf(
  routeId: PublicRouteId,
): Record<string, unknown> {
  const route: PublicRouteDef = PUBLIC_ROUTES[routeId];
  const headers = routeCacheControlHeadersOf(routeId);
  return Object.fromEntries(
    (route.alternateSuccesses ?? []).map((alternate) => [
      String(alternate.status),
      {
        description: alternate.description,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(alternate.responseSchema === null
          ? {}
          : {
              content: {
                'application/json': { schema: alternate.responseSchema },
              },
            }),
      },
    ]),
  );
}

function cacheControlHeadersOf(
  policy: CacheControlPolicy | undefined,
): Record<string, unknown> {
  if (policy === undefined) return {};
  return {
    'Cache-Control': {
      ...(policy.description === undefined
        ? {}
        : { description: policy.description }),
      schema: { type: 'string', enum: [policy.value] },
    },
  };
}

export function routeCacheControlHeadersOf(
  routeId: PublicRouteId,
): Record<string, unknown> {
  const route: PublicRouteDef = PUBLIC_ROUTES[routeId];
  return cacheControlHeadersOf(route.cacheControl);
}

export function routeSecurityOf(
  routeId: PublicRouteId,
): Record<string, unknown> {
  switch (PUBLIC_ROUTES[routeId].callerAuth) {
    case 'bearer':
      return { security: [{ BearerAuth: [] }] };
    case 'api-key':
      return { security: [{ ApiKeyAuth: [] }] };
    case 'refresh-cookie':
      return { security: [{ RefreshCookie: [] }] };
    case 'bff-client-secret':
      return { security: [{ BffClientSecret: [] }] };
    case 'bff-api-key':
      return { security: [{ ApiKeyAuth: [], BffClientSecret: [] }] };
    case 'none':
      return { security: [] };
  }
}

/**
 * Every `429` on an authentication route is the one refusal the auth module
 * builds, so every one of them answers with the retry hint. The gateway's
 * per-operation limit is a different refusal on routes that carry an API key,
 * and it carries no header; that difference is what this keeps separate.
 */
function carriesRetryAfterHeader(routeId: PublicRouteId): boolean {
  return routeId.startsWith('auth.');
}

export function routeErrorResponsesOf(
  routeId: PublicRouteId,
  groupedErrors?: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const { errorStatuses } = PUBLIC_ROUTES[routeId];

  if (errorStatuses === 'all-except-idempotency-conflict') {
    if (groupedErrors === undefined) {
      throw new Error(
        `${routeId} derives its error statuses and needs the error registry`,
      );
    }
    return Object.fromEntries(
      [...groupedErrors]
        .filter(
          ([status, codes]) =>
            status !== 409 &&
            !codes.every((code) => NAMED_DOWNSTREAM_ERRORS.has(code)),
        )
        .map(([status]) => [
          String(status),
          { $ref: `#/components/responses/Error${status}` },
        ]),
    );
  }

  return Object.fromEntries(
    errorStatuses.map((status) => [
      String(status),
      {
        $ref:
          status === 429 && carriesRetryAfterHeader(routeId)
            ? '#/components/responses/AuthRateLimited'
            : `#/components/responses/Error${status}`,
      },
    ]),
  );
}

/**
 * `x-idempotency` and the `Idempotent-Replay` header appear only where the
 * registry declares an idempotency mode, so a mode change in one place cannot
 * leave a stale extension behind in the document.
 */
export function routeIdempotencyExtensionsOf(
  routeId: PublicRouteId,
): Record<string, unknown> {
  const { idempotency } = PUBLIC_ROUTES[routeId];
  return idempotency === 'none' ? {} : { 'x-idempotency': idempotency };
}

/**
 * The published `x-identity-scope` extension, or nothing when the document
 * omits it. The value is the one the registry records as a fact about the
 * document, not a claim about what the route resolves.
 */
export function routeIdentityScopeOf(
  routeId: PublicRouteId,
): Record<string, unknown> {
  const scope = PUBLIC_ROUTES[routeId].publishedIdentityScope;
  return scope === null ? {} : { 'x-identity-scope': scope };
}

export function routeReplayHeaderOf(
  routeId: PublicRouteId,
  description: string,
): { readonly headers?: Readonly<Record<string, unknown>> } {
  if (PUBLIC_ROUTES[routeId].idempotency === 'none') {
    return {};
  }
  return {
    headers: {
      'Idempotent-Replay': {
        description,
        schema: { type: 'string', enum: ['true'] },
      },
    },
  };
}

/**
 * The error registry is the source of truth for status/code groupings. A
 * 409 response remains operation-specific because only idempotent operations
 * can reach an idempotency conflict.
 */
export function errorsByStatus(): ReadonlyMap<
  HttpStatus,
  readonly ErrorCode[]
> {
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

const NAMED_DOWNSTREAM_ERRORS: ReadonlySet<ErrorCode> = new Set(
  Object.values(OPERATION_CATALOG).flatMap(
    (operation: OperationDef) => operation.namedDownstreamErrors ?? [],
  ),
);

/**
 * Mirrors the public success envelope built by
 * `src/common/http/success-envelope.ts` field for field — `correlation_id`
 * is genuinely optional there (only present when the client sent
 * `X-Correlation-Id`), not merely undocumented.
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

export function idempotencyKeyParameter(
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
          ? 'Optional. When supplied, the key replays the completed result for a repeat call.'
          : 'Ignored. This operation never stores or replays an idempotency record.',
  };
}

export const CORRELATION_ID_PARAMETER = {
  name: 'X-Correlation-Id',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description:
    "Client-supplied trace id, echoed back in `meta.correlation_id`. Never used as the request's own identity — that is always AIHUB-generated as `meta.request_id`.",
};

export const USER_IDENTITY_PARAMETER = {
  name: 'X-User-Identity',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1 },
  description:
    'Identifies the end user on user-scoped operations. For an Organization with an active identity configuration it must be a Signed User Assertion; otherwise it is a Declared User ID: 1-256 visible ASCII characters with no spaces, compared exactly as sent.',
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

export function operationToPathItem(
  operationId: OperationId,
  operation: OperationDef,
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const parameters = [
    { $ref: '#/components/parameters/CorrelationId' },
    operation.identityScope === 'user'
      ? { $ref: '#/components/parameters/UserIdentity' }
      : undefined,
    idempotencyKeyParameter(operation.idempotency),
  ].filter((parameter) => parameter !== undefined);

  const successHeaders = {
    ...cacheControlHeadersOf(operation.cacheControl),
    ...(operation.idempotency !== 'none'
      ? {
          'Idempotent-Replay': {
            description:
              'Present with value true when the completed business result was replayed for this key.',
            schema: { type: 'string', enum: ['true'] },
          },
        }
      : {}),
  };
  const responses: Record<string, unknown> = {
    '200': {
      description: 'Success',
      ...(Object.keys(successHeaders).length === 0
        ? {}
        : { headers: successHeaders }),
      content: {
        'application/json': {
          schema: successEnvelopeSchema(
            resolvedResponseSchema(operationId, operation),
          ),
        },
      },
    },
  };

  for (const [status, codes] of groupedErrors) {
    if (status === 409 && operation.idempotency === 'none') {
      continue;
    }
    // A status reached only through another operation's named provider
    // failure is not this operation's to publish.
    if (
      codes.every(
        (code) =>
          NAMED_DOWNSTREAM_ERRORS.has(code) &&
          !(operation.namedDownstreamErrors ?? []).includes(code),
      )
    ) {
      continue;
    }
    responses[String(status)] = {
      $ref: `#/components/responses/Error${status}`,
    };
  }

  return {
    [operation.method.toLowerCase()]: {
      operationId,
      summary: operation.openApi.summary,
      ...(operation.openApi.description === undefined
        ? {}
        : { description: operation.openApi.description }),
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
      ...operation.openApi.extensions,
    },
  };
}

export function publicRouteToPathItem(
  routeId: PublicRouteId,
): Record<string, unknown> {
  const route: PublicRouteDef = PUBLIC_ROUTES[routeId];
  const metadata = route.openApi;
  if (metadata === undefined) {
    throw new Error(`${routeId} has no OpenAPI operation metadata`);
  }

  const parameters = [
    ...(metadata.includeCorrelationId === false
      ? []
      : [{ $ref: '#/components/parameters/CorrelationId' }]),
    ...(route.idempotency === 'none'
      ? []
      : [idempotencyKeyParameter(route.idempotency)]),
    ...(route.publishedIdentityScope === 'user'
      ? [{ $ref: '#/components/parameters/UserIdentity' }]
      : []),
    ...(metadata.parameters ?? []),
  ];
  const successHeaders = {
    ...routeCacheControlHeadersOf(routeId),
    ...(metadata.replayHeaderDescription === undefined
      ? {}
      : routeReplayHeaderOf(routeId, metadata.replayHeaderDescription).headers),
  };
  const responses: Record<string, unknown> = {
    [routeSuccessKeyOf(routeId)]: {
      description: metadata.successDescription,
      ...(Object.keys(successHeaders).length === 0
        ? {}
        : { headers: successHeaders }),
      ...(route.responseSchema === null
        ? {}
        : {
            content: {
              'application/json': {
                schema: routeSchemaOf(routeId, 'response'),
              },
            },
          }),
    },
    ...routeAlternateSuccessResponsesOf(routeId),
    ...routeErrorResponsesOf(routeId),
  };

  return {
    [route.method.toLowerCase()]: {
      operationId: routeId,
      summary: metadata.summary,
      ...(metadata.description === undefined
        ? {}
        : { description: metadata.description }),
      ...routeIdentityScopeOf(routeId),
      ...routeIdempotencyExtensionsOf(routeId),
      ...routeSecurityOf(routeId),
      parameters,
      ...(route.requestSchema === null
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: routeSchemaOf(routeId, 'request'),
                },
              },
            },
          }),
      responses,
      ...metadata.extensions,
    },
  };
}

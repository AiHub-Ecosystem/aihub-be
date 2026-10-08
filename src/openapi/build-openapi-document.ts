import { type TObject, type TSchema, Type } from '@sinclair/typebox';

import type {
  IdempotencyMode,
  OperationDef,
} from '@/catalog/operation-catalog';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { OPERATION_IDS } from '@/catalog/operation-id';
import type { OperationId } from '@/catalog/operation-id';
import type { PublicRouteId } from '@/catalog/public-routes';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { ERROR_CODES, type ErrorCode } from '@/common/errors/error-code';
import {
  type HttpStatus,
  httpStatusForErrorCode,
} from '@/common/errors/error-registry';
import { PUBLIC_API_SERVERS } from '@/config/runtime-configuration';
import {
  ForgotPasswordResponseSchema,
  LoginResponseSchema,
  PASSWORD_POLICY_DESCRIPTION,
  RegisterResponseSchema,
} from '@/contracts/auth/local-auth';
import { CreateWebSessionResponseSchema } from '@/contracts/auth/web-session';
import {
  DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE,
  MAX_ORGANIZATION_AUDIT_PAGE_SIZE,
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_AUDIT_OUTCOMES,
} from '@/contracts/organization/audit-event';
import { MintSandboxAssertionResponseSchema } from '@/contracts/sandbox/assertion';
import { SpeakingQuestionsQuerySchema } from '@/contracts/speaking/questions';
import {
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
} from '@/modules/auth/domain/local-auth';
import {
  REFRESH_COOKIE_NAME,
  WEB_SESSION_CLIENT_SECRET_HEADER,
} from '@/modules/auth/presentation/refresh-cookie';
import { toOpenApiPath } from './openapi-path';

/**
 * Reads a route's declared data out of the Public API Route registry. A missing
 * schema is a registry error, not a document error: a bodyless route that asks
 * for a schema means the entry and the path item disagree about what it accepts.
 */
function routeSchemaOf(
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

function routePathOf(routeId: PublicRouteId): string {
  return toOpenApiPath(PUBLIC_ROUTES[routeId].path);
}

function routeSuccessKeyOf(routeId: PublicRouteId): string {
  return String(PUBLIC_ROUTES[routeId].successStatus);
}

function routeSecurityOf(routeId: PublicRouteId): Record<string, unknown> {
  switch (PUBLIC_ROUTES[routeId].callerAuth) {
    case 'bearer':
      return { security: [{ BearerAuth: [] }] };
    case 'api-key':
      return { security: [{ ApiKeyAuth: [] }] };
    case 'refresh-cookie':
      return { security: [{ RefreshCookie: [] }] };
    case 'bff-client-secret':
      return { security: [{ BffClientSecret: [] }] };
    case 'none':
      return { security: [] };
  }
}

function routeErrorResponsesOf(
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
      [...groupedErrors.keys()]
        .filter((status) => status !== 409)
        .map((status) => [
          String(status),
          { $ref: `#/components/responses/Error${status}` },
        ]),
    );
  }

  return Object.fromEntries(
    errorStatuses.map((status) => [
      String(status),
      { $ref: `#/components/responses/Error${status}` },
    ]),
  );
}

/**
 * `x-idempotency` and the `Idempotent-Replay` header appear only where the
 * registry declares an idempotency mode, so a mode change in one place cannot
 * leave a stale extension behind in the document.
 */
function routeIdempotencyExtensionsOf(
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
function routeIdentityScopeOf(routeId: PublicRouteId): Record<string, unknown> {
  const scope = PUBLIC_ROUTES[routeId].publishedIdentityScope;
  return scope === null ? {} : { 'x-identity-scope': scope };
}

function routeReplayHeaderOf(
  routeId: PublicRouteId,
  description: string,
): Record<string, unknown> {
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
          ? 'Optional. When supplied, the key replays the completed result for a repeat call.'
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

const USER_IDENTITY_PARAMETER = {
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

function operationToPathItem(
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

function refreshInvalidResponse(): Record<string, unknown> {
  return {
    description: 'Refresh credential is missing, invalid, expired, or revoked',
    content: {
      'application/json': {
        schema: errorResponseSchema(['AUTH_REFRESH_TOKEN_INVALID']),
      },
    },
  };
}

/** Both codes the Web Session route can answer 401 with, and nothing finer. */
function webSessionRefusedResponse(): Record<string, unknown> {
  return {
    description:
      'Client secret missing or wrong, or the email and password are not an active account',
    content: {
      'application/json': {
        schema: errorResponseSchema([
          'UNAUTHORIZED',
          'AUTH_CREDENTIALS_INVALID',
        ]),
      },
    },
  };
}

/**
 * The exchange's two 401 codes, and nothing finer: a missing or wrong client
 * secret, and the one generic code every unusable session answers.
 */
function webSessionExchangeRefusedResponse(): Record<string, unknown> {
  return {
    description:
      'Client secret missing or wrong, or the Web Session token is expired, revoked, unknown, malformed, or belongs to an account that is not active',
    content: {
      'application/json': {
        schema: errorResponseSchema([
          'UNAUTHORIZED',
          'AUTH_WEB_SESSION_INVALID',
        ]),
      },
    },
  };
}

function publishedLocalAuthRequestSchema(schema: TSchema): TSchema {
  // The three routes that publish a password re-state the policy so a generated
  // client enforces it, which means restating the object rather than merging a
  // flag. A non-object schema here is a contract bug, not a document one.
  if (!('properties' in schema)) {
    throw new Error('a published local-auth request must be an object schema');
  }

  const objectSchema = schema as TObject;
  const options =
    objectSchema.additionalProperties === undefined
      ? {}
      : { additionalProperties: objectSchema.additionalProperties };

  return Type.Object(
    {
      ...objectSchema.properties,
      password: Type.String({
        minLength: PASSWORD_MIN_CODE_POINTS,
        maxLength: PASSWORD_MAX_CODE_POINTS,
        description: PASSWORD_POLICY_DESCRIPTION,
      }),
    },
    options,
  );
}

function localAuthPathItems(): Record<string, Record<string, unknown>> {
  // Keep auth responses intentionally narrow: these routes do not carry API
  // key, assertion, downstream, or idempotency behavior. The success status,
  // the error statuses, and the security entry come from the registry; the
  // response prose stays here.
  const registerResponses = {
    '201': {
      description: 'Account created and pending email verification',
      content: { 'application/json': { schema: RegisterResponseSchema } },
    },
    ...routeErrorResponsesOf('auth.register'),
  };
  const loginResponses = {
    '200': {
      description: 'Access token issued',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'The host-only refresh cookie for the new session.',
          schema: { type: 'string' },
        },
      },
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    ...routeErrorResponsesOf('auth.login'),
  };
  const verifyResponses = {
    '200': {
      ...loginResponses['200'],
      description:
        'Verification Sign-in (ADR-0054): the request carried the Signup Browser Binding of the browser that requested this token, which had not signed in yet. Same session as a login.',
    },
    '204': {
      description:
        'Email verified without signing in: no binding, another browser, or the token already signed in. Re-submitting the same unexpired token that activated the still-active account also succeeds.',
    },
    ...routeErrorResponsesOf('auth.verify_email'),
  };
  const resendResponses = {
    '202': { description: 'Verification resend accepted' },
    ...routeErrorResponsesOf('auth.resend_verification'),
  };
  const forgotPasswordResponses = {
    '202': {
      description: 'Password recovery request accepted',
      content: {
        'application/json': { schema: ForgotPasswordResponseSchema },
      },
    },
    ...routeErrorResponsesOf('auth.forgot_password'),
  };
  const resetPasswordResponses = {
    '204': {
      description: 'Password reset and refresh sessions revoked',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'An expired host-only refresh cookie.',
          schema: { type: 'string' },
        },
      },
    },
    ...routeErrorResponsesOf('auth.reset_password'),
  };
  const refreshResponses = {
    '200': {
      description: 'Access token issued and refresh cookie rotated',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'The rotated host-only refresh cookie.',
          schema: { type: 'string' },
        },
      },
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    ...routeErrorResponsesOf('auth.refresh'),
    '401': refreshInvalidResponse(),
  };
  const logoutResponses = {
    '204': {
      description: 'Refresh session revoked and cookie cleared',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
        'Set-Cookie': {
          description: 'An expired host-only refresh cookie.',
          schema: { type: 'string' },
        },
      },
    },
    ...routeErrorResponsesOf('auth.logout'),
  };

  const operation = (
    operationId: PublicRouteId,
    summary: string,
    schema: TSchema,
    responses: Record<string, unknown>,
    requestBodyRequired = true,
  ): Record<string, unknown> => ({
    post: {
      operationId,
      summary,
      ...routeIdentityScopeOf(operationId),
      ...routeSecurityOf(operationId),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: requestBodyRequired,
        content: { 'application/json': { schema } },
      },
      responses,
    },
  });

  return {
    [routePathOf('auth.register')]: operation(
      'auth.register',
      'Register a local AIHUB account',
      publishedLocalAuthRequestSchema(
        routeSchemaOf('auth.register', 'request'),
      ),
      registerResponses,
    ),
    [routePathOf('auth.login')]: operation(
      'auth.login',
      'Issue a User Access JWT',
      publishedLocalAuthRequestSchema(routeSchemaOf('auth.login', 'request')),
      loginResponses,
    ),
    [routePathOf('auth.verify_email')]: operation(
      'auth.verify_email',
      'Verify a local account email address',
      routeSchemaOf('auth.verify_email', 'request'),
      verifyResponses,
    ),
    [routePathOf('auth.resend_verification')]: operation(
      'auth.resend_verification',
      'Request a verification email resend',
      routeSchemaOf('auth.resend_verification', 'request'),
      resendResponses,
    ),
    [routePathOf('auth.forgot_password')]: operation(
      'auth.forgot_password',
      'Request a password reset email',
      routeSchemaOf('auth.forgot_password', 'request'),
      forgotPasswordResponses,
    ),
    [routePathOf('auth.reset_password')]: operation(
      'auth.reset_password',
      'Reset a local account password',
      publishedLocalAuthRequestSchema(
        routeSchemaOf('auth.reset_password', 'request'),
      ),
      resetPasswordResponses,
    ),
    [routePathOf('auth.refresh')]: operation(
      'auth.refresh',
      'Rotate a refresh session and issue a User Access JWT',
      routeSchemaOf('auth.refresh', 'request'),
      refreshResponses,
      false,
    ),
    [routePathOf('auth.logout')]: operation(
      'auth.logout',
      'Revoke the current refresh session',
      routeSchemaOf('auth.logout', 'request'),
      logoutResponses,
      false,
    ),
  };
}

/**
 * The Customer Web BFF route group. A browser never calls these: the caller is
 * a server holding the BFF client secret, and the Web Session token comes back
 * in the body rather than in a cookie AIHUB could not set for another host.
 */
function webSessionPathItems(): Record<string, Record<string, unknown>> {
  const createResponses = {
    '201': {
      description:
        'Web Session created. The opaque token travels in this body, never in a cookie: the Customer Web BFF stores it in its own HttpOnly cookie.',
      headers: {
        'Cache-Control': {
          schema: { type: 'string', enum: ['no-store'] },
        },
      },
      content: {
        'application/json': { schema: CreateWebSessionResponseSchema },
      },
    },
    ...routeErrorResponsesOf('auth.web_sessions.create'),
    // One generic 401 covers a missing or wrong client secret and a wrong,
    // unknown, pending-verification, or disabled credential alike: the route
    // cannot tell them apart, so the document must not look as though it can.
    '401': webSessionRefusedResponse(),
  };

  return {
    [routePathOf('auth.web_sessions.create')]: {
      post: {
        operationId: 'auth.web_sessions.create',
        summary: 'Create a Web Session from an email and password',
        description:
          'Server-to-server only, Customer Web BFF. AIHUB stores only the token hash, never sets a cookie for this route, and applies the same credential checks and login rate limits as POST /v1/auth/login.',
        ...routeIdentityScopeOf('auth.web_sessions.create'),
        ...routeSecurityOf('auth.web_sessions.create'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: publishedLocalAuthRequestSchema(
                routeSchemaOf('auth.web_sessions.create', 'request'),
              ),
            },
          },
        },
        responses: createResponses,
      },
    },
    [routePathOf('auth.web_sessions.verification')]: {
      post: {
        operationId: 'auth.web_sessions.verification',
        summary: 'Create a Web Session from a verification token',
        description:
          'Server-to-server only, Customer Web BFF. The verification token and the Signup Browser Binding received at signup: a binding that does not match verifies the email and answers 204 with no session, and one token creates at most one session whichever route reaches it first. Applies the same verification rate limits as POST /v1/auth/verify-email.',
        ...routeIdentityScopeOf('auth.web_sessions.verification'),
        ...routeSecurityOf('auth.web_sessions.verification'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              // No `publishedLocalAuthRequestSchema`: this request carries no
              // password, so there is no policy to re-state for a generated
              // client.
              schema: routeSchemaOf(
                'auth.web_sessions.verification',
                'request',
              ),
            },
          },
        },
        responses: {
          ...createResponses,
          // 204 is not an error: the email is verified and no session was
          // granted, which is the same answer POST /v1/auth/verify-email gives.
          '204': { description: 'Email verified; no Web Session created.' },
        },
      },
    },
    [routePathOf('auth.web_sessions.exchange')]: {
      post: {
        operationId: 'auth.web_sessions.exchange',
        summary: 'Exchange a Web Session for a User Access JWT',
        description:
          'Server-to-server only, Customer Web BFF. The stateless exchange: every call signs a fresh User Access JWT through the same issuer as POST /v1/auth/login, with the same claims, audience, issuer, and 15-minute lifetime, and AIHUB stores nothing for it. The Web Session token travels in this body and nowhere else — a token offered in a cookie, an authorization header, or a query parameter is refused. A successful exchange slides the Web Session expiry 30 days forward and writes nothing when the last renewal is less than about an hour old, so concurrent exchanges need no lock and no shared store. AIHUB keeps no record of an issued JWT, so a BFF may cache one in process until shortly before it expires; a JWT signed before a logout therefore stays valid for up to 15 minutes.',
        ...routeIdentityScopeOf('auth.web_sessions.exchange'),
        ...routeSecurityOf('auth.web_sessions.exchange'),
        parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: routeSchemaOf('auth.web_sessions.exchange', 'request'),
            },
          },
        },
        responses: {
          '200': {
            description:
              'User Access JWT issued. Same envelope as POST /v1/auth/login; no cookie is set for this route.',
            headers: {
              'Cache-Control': {
                schema: { type: 'string', enum: ['no-store'] },
              },
            },
            content: {
              'application/json': {
                schema: routeSchemaOf('auth.web_sessions.exchange', 'response'),
              },
            },
          },
          ...routeErrorResponsesOf('auth.web_sessions.exchange'),
          // One code for every session that cannot be exchanged — expired,
          // revoked, unknown, malformed, or a non-active account — so the BFF
          // clears the cookie and asks for a sign-in without learning which.
          '401': webSessionExchangeRefusedResponse(),
        },
      },
    },
  };
}

function organizationInvitationAcceptPathItem(): Record<string, unknown> {
  const id = 'organizations.invitations.accept' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Accept an organization invitation',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Organization membership granted or reactivated',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationPathItem(): Record<string, unknown> {
  const id = 'organizations.create' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Create a Self-serve Organization and become its first owner',
      description:
        'Commercial terms are operator-controlled defaults and cannot be set by the request. Each account may create a limited number of Organizations over its lifetime.',
      ...routeIdentityScopeOf(id),
      ...routeIdempotencyExtensionsOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        idempotencyKeyParameter(PUBLIC_ROUTES[id].idempotency),
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'Organization created with the caller as its active owner',
          ...routeReplayHeaderOf(
            id,
            'Present with value true when the completed creation result was replayed for this key.',
          ),
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

/**
 * Owner-only and name-only (ADR-0043). No Idempotency-Key: a repeat of the
 * applied name succeeds and changes nothing.
 */
function organizationItemPathItem(): Record<string, unknown> {
  const id = 'organizations.rename' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Rename an organization',
      description:
        'Only an active owner of an active organization may rename it. Every other caller, and a suspended organization, receives the same denial. Commercial terms and status cannot be changed by this request.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization to rename.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'The organization under its current name',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

/**
 * Described by hand for the same reason as the roster: it is a management
 * route, not a catalogued proxy operation.
 */
function organizationInvitationPathItem(): Record<string, unknown> {
  const list = 'organizations.invitations.list' as const;
  const create = 'organizations.invitations.create' as const;

  return {
    get: {
      operationId: list,
      summary: "List an organization's open invitations",
      ...routeIdentityScopeOf(list),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose open invitations are listed.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      responses: {
        [routeSuccessKeyOf(list)]: {
          description: 'Open organization invitations',
          content: {
            'application/json': {
              schema: routeSchemaOf(list, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(list),
      },
    },
    post: {
      operationId: create,
      summary: 'Invite a person to an organization',
      ...routeIdentityScopeOf(create),
      ...routeIdempotencyExtensionsOf(create),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        idempotencyKeyParameter(PUBLIC_ROUTES[create].idempotency),
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization the invited person is invited to.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(create, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(create)]: {
          description:
            'Pending organization invitation created; the single-use invite credential reaches the invited person by email only',
          ...routeReplayHeaderOf(
            create,
            'Present with value true when the completed invitation result was replayed for this key.',
          ),
          content: {
            'application/json': {
              schema: routeSchemaOf(create, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(create),
      },
    },
  };
}

function organizationInvitationItemPathItem(): Record<string, unknown> {
  const id = 'organizations.invitations.revoke' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Revoke an organization invitation',
      description:
        'Closes an open invitation using the durable invitation close signal. An already closed or expired invitation is a retry-safe no-op and still returns bodyless 204.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that owns the invitation.',
          schema: { type: 'string', minLength: 1 },
        },
        {
          name: 'invitation_id',
          in: 'path',
          required: true,
          description: 'The invitation being revoked.',
          schema: {
            type: 'string',
            pattern: '^oiv_[0-9A-HJKMNP-TV-Z]{26}$',
          },
        },
      ],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'Invitation closed, or already closed/expired; the response has no body',
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationApiKeyItemPathItem(): Record<string, unknown> {
  const id = 'organizations.apiKeys.revoke' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Revoke an organization API key',
      description:
        'Withdraws the key and keeps its durable row, purging the identity cache so the change takes effect inside the existing cache ceiling. State-idempotent: withdrawing an already withdrawn key succeeds and leaves the recorded moment unchanged. This is the only response from which `revoked` is reachable.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that owns the API key.',
          schema: { type: 'string', minLength: 1 },
        },
        {
          name: 'api_key_id',
          in: 'path',
          required: true,
          description: 'The API key being withdrawn.',
          schema: { type: 'string', pattern: '^ak_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'API key withdrawn; its durable row is kept',
          content: {
            'application/json': {
              schema: routeSchemaOf(id, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationApiKeyRotatePathItem(): Record<string, unknown> {
  const id = 'organizations.apiKeys.rotate' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Rotate an organization API key',
      description:
        'Creates a replacement and revokes the named key in one act, with no window in which both work. The replacement inherits the name, scopes, allowed environments, and expiry, and its raw credential is returned in this response only. A revoked or expired key cannot be rotated.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that owns the API key.',
          schema: { type: 'string', minLength: 1 },
        },
        {
          name: 'api_key_id',
          in: 'path',
          required: true,
          description: 'The API key being retired.',
          schema: { type: 'string', pattern: '^ak_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'API key rotated; the raw replacement is returned in this response only and cannot be recovered afterwards. `status` is always `active`.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationApiKeyPathItem(): Record<string, unknown> {
  const list = 'organizations.apiKeys.list' as const;
  const create = 'organizations.apiKeys.create' as const;

  return {
    get: {
      operationId: list,
      summary: 'List an organization API key inventory',
      description:
        'Returns the organization live API keys as metadata only. Revoked keys are absent; `status` is `expired` once a key expiry has passed. `last_used_at` is approximate.',
      ...routeIdentityScopeOf(list),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose API keys are listed.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      responses: {
        [routeSuccessKeyOf(list)]: {
          description:
            'Live API key inventory; never a credential hash or raw credential',
          content: {
            'application/json': {
              schema: routeSchemaOf(list, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(list),
      },
    },
    post: {
      operationId: create,
      summary: 'Create an organization API key',
      ...routeIdentityScopeOf(create),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that will own the API key.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(create, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(create)]: {
          description:
            'API key created; the raw credential is returned in this response only and cannot be recovered afterwards. `status` is always `active`: a requested expiry must be in the future, so this response never carries `expired`.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': {
              schema: routeSchemaOf(create, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(create),
      },
    },
  };
}

/**
 * The first path in this document to carry query parameters. `action` is
 * declared `explode: true` on purpose: the server reads a repeated key, so a
 * generated client that comma-joined its values would send something no
 * parameter here accepts.
 */
function organizationAuditEventPathItem(): Record<string, unknown> {
  const id = 'organizations.auditEvents.list' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Read an organization audit trail',
      description:
        'Returns the organization recorded control-plane acts, newest first, paginated by an opaque cursor. Active owners and admins may read; members, non-members, and disabled memberships receive one indistinguishable denial. A suspended organization stays readable, because the trail is evidence rather than a management surface. The actor is named by immutable username: no user account id, target id, key hash, or token hash appears. An event whose label has been removed by audit redaction is returned with `target_label` null rather than hidden.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose audit trail is read.',
          schema: { type: 'string', minLength: 1 },
        },
        {
          name: 'action',
          in: 'query',
          required: false,
          description:
            'Restrict the trail to these audit actions. Repeat the key for several values; an unrecognized value is rejected rather than treated as an empty filter.',
          style: 'form',
          explode: true,
          schema: {
            type: 'array',
            items: { type: 'string', enum: [...ORGANIZATION_AUDIT_ACTIONS] },
          },
        },
        {
          name: 'outcome',
          in: 'query',
          required: false,
          description:
            'Restrict the trail to acts that took effect, or to refused attempts against a real target.',
          schema: { type: 'string', enum: [...ORGANIZATION_AUDIT_OUTCOMES] },
        },
        {
          name: 'from',
          in: 'query',
          required: false,
          description:
            'Inclusive start of a half-open UTC window. Independent of `to`.',
          schema: { type: 'string', format: 'date-time' },
        },
        {
          name: 'to',
          in: 'query',
          required: false,
          description:
            'Exclusive end of a half-open UTC window, so adjacent windows tile without counting an event twice.',
          schema: { type: 'string', format: 'date-time' },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          description:
            'Events per page. A value outside the range is rejected rather than clamped, because a silently shortened page is indistinguishable from the end of the trail.',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ORGANIZATION_AUDIT_PAGE_SIZE,
            default: DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE,
          },
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          description:
            'Opaque position from a previous `next_cursor`. Bound to the filters it was issued under: replaying it with different filters is rejected.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'One page of recorded acts, newest first. `next_cursor` is null at the end of the trail.',
          content: {
            'application/json': {
              schema: routeSchemaOf(id, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationIdentityConfigPathItem(): Record<string, unknown> {
  const read = 'organizations.identityConfig.read' as const;
  const set = 'organizations.identityConfig.set' as const;

  return {
    put: {
      operationId: set,
      summary: 'Set an organization identity configuration',
      description:
        'Creates or replaces the public Signed User Assertion identity configuration for an active owner of an active Organization. Submit exactly one JWKS source. URL sources are fetched through the SSRF-protected JWKS path before saving. Existing status is preserved. A retryable cache error may mean the durable save succeeded; retrying the same request safely retries cache purge.',
      ...routeIdentityScopeOf(set),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose identity configuration is set.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(set, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(set)]: {
          description:
            'The stored public identity configuration, including its preserved status.',
          content: {
            'application/json': { schema: routeSchemaOf(set, 'response') },
          },
        },
        ...routeErrorResponsesOf(set),
      },
    },
    get: {
      operationId: read,
      summary: 'Read an organization identity configuration',
      description:
        'Returns the stored public Signed User Assertion identity configuration to an active owner of an active Organization. Admins, members, disabled memberships, non-members, and owners of suspended Organizations receive the same Safe Authorization Denial. `configured` indicates whether a row exists, including disabled rows; `status` indicates whether that configuration is active. Private JWK members are never returned.',
      ...routeIdentityScopeOf(read),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose identity configuration is read.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      responses: {
        [routeSuccessKeyOf(read)]: {
          description:
            'Stored public identity configuration, or `configured: false` when no row exists.',
          content: {
            'application/json': {
              schema: routeSchemaOf(read, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(read),
      },
    },
  };
}

function organizationRosterPathItem(): Record<string, unknown> {
  const id = 'organizations.me.members.list' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'List the authenticated user organization roster',
      description:
        'Returns the Organizations where the authenticated user has an active membership, including suspended Organizations. `identity_configured` reports only whether an active identity configuration is saved; the JWKS source is not probed and its URL or key material is not returned.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Organization roster',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationMembershipListPathItem(): Record<string, unknown> {
  const id = 'organizations.members.list' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: "List an organization's memberships",
      description:
        'Active owners and admins may list active or disabled memberships for one active Organization. The filter defaults to active membership and does not depend on the member account status. Results are ordered by immutable username and omit account IDs and email addresses.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose memberships are listed.',
          schema: { type: 'string', minLength: 1 },
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          description: 'Membership status to list. Defaults to active.',
          schema: {
            type: 'string',
            enum: ['active', 'disabled'],
            default: 'active',
          },
        },
      ],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Organization memberships',
          content: {
            'application/json': {
              schema: routeSchemaOf(id, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationMemberParameters(): readonly Record<string, unknown>[] {
  return [
    { $ref: '#/components/parameters/CorrelationId' },
    {
      name: 'organization_id',
      in: 'path',
      required: true,
      description: 'The organization whose membership is being changed.',
      schema: { type: 'string', minLength: 1 },
    },
    {
      name: 'username',
      in: 'path',
      required: true,
      description: 'The immutable public username of the target member.',
      schema: { type: 'string', minLength: 1 },
    },
  ];
}

function organizationMembershipMutationPathItem(): Record<string, unknown> {
  const changeRole = 'organizations.members.change_role' as const;
  const disable = 'organizations.members.disable' as const;

  const successFor = (id: typeof changeRole | typeof disable) => ({
    [routeSuccessKeyOf(id)]: {
      description: 'The resulting organization membership',
      content: {
        'application/json': { schema: routeSchemaOf(id, 'response') },
      },
    },
  });

  return {
    patch: {
      operationId: changeRole,
      summary: 'Change an organization member role',
      ...routeIdentityScopeOf(changeRole),
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: routeSchemaOf(changeRole, 'request'),
          },
        },
      },
      responses: {
        ...successFor(changeRole),
        ...routeErrorResponsesOf(changeRole),
      },
    },
    delete: {
      operationId: disable,
      summary: 'Disable an organization member',
      ...routeIdentityScopeOf(disable),
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      responses: {
        ...successFor(disable),
        ...routeErrorResponsesOf(disable),
      },
    },
  };
}

function organizationMembershipTransferPathItem(): Record<string, unknown> {
  const id = 'organizations.members.transfer' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Transfer organization ownership',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'The resulting organization membership',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

/**
 * Its path, schemas, error statuses, and security come from
 * `PUBLIC_ROUTES`; the description and the envelope stay here, because those
 * are what make it this route.
 *
 * It is not a dispatch operation: it has no downstream service, no downstream
 * contract, and no scope, so it does not belong in `OPERATION_CATALOG` either.
 * Putting it there to reuse `operationToPathItem` would put a phantom proxy
 * operation in front of every reader of this document.
 *
 * The envelope is narrower than a proxied operation's for the same reason. A
 * dispatch envelope reports downstream and gateway timings for a call that
 * reached an AI service; this one reaches none, and publishing zeroed timings
 * would describe a measurement nobody took.
 */
function sandboxAssertionPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const id = 'sandbox.assertions.mint' as const;
  const responses: Record<string, unknown> = {
    '200': {
      description: 'A freshly signed assertion for the sandbox organization',
      content: {
        'application/json': {
          schema: Type.Object(
            {
              data: MintSandboxAssertionResponseSchema,
              meta: Type.Object(
                {
                  request_id: Type.String({
                    pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
                  }),
                },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
        },
      },
    },
  };

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Mint a sandbox user assertion',
      description: [
        'Issues a short-lived user assertion for the sandbox organization, so that exercising the API does not require holding an organization signing key.',
        'Available only to API keys belonging to a configured sandbox organization; every other key is refused. Deployments with no sandbox configured answer 404.',
        'This is not the integration pattern for a customer with their own backend. Such a customer signs assertions from their own identity provider and never calls this route.',
      ].join('\n\n'),
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        ...responses,
        ...routeErrorResponsesOf(id, groupedErrors),
      },
    },
  };
}

function avatarUploadPathItem(): Record<string, unknown> {
  const id = 'me.avatar.uploads.create' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Request an Avatar upload URL',
      description:
        'Mints a presigned `PUT` URL that writes exactly one object for the signed-in AIHUB User Account, with the declared content type, the length, and `Cache-Control: public, max-age=3600` bound into the signature. Send the image bytes straight to that URL with all three returned headers; they never pass through AIHUB. Nothing is recorded until the upload is completed, which must happen within one hour of the upload. Allowed types are `image/jpeg`, `image/png`, and `image/webp`, up to 2 MiB; the URL expires after 5 minutes. An account that already has an Avatar may request one to replace it.',
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'Upload URL minted. The URL is a write credential for one object and is returned only here.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function avatarCompletePathItem(): Record<string, unknown> {
  const id = 'me.avatar.uploads.complete' as const;
  const avatarContent = {
    'application/json': { schema: routeSchemaOf(id, 'response') },
  };

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Complete an Avatar upload',
      description:
        'Checks the object that actually landed for this asset and records it as the Avatar of the signed-in AIHUB User Account. An object that is missing, or that was stored more than an hour ago, answers `404` and an expired one is deleted; one that is larger than 2 MiB, has an unsupported type, or is empty is refused and deleted. When the account already has a different Avatar, its image is deleted first and the new one replaces it; if that delete fails the account keeps its Avatar and the call answers `503`, and retrying finishes the replacement. `409 AVATAR_CHANGED` means another request changed the Avatar first; re-read before retrying. The response describes the image, including its published `url`.',
      ...routeIdentityScopeOf(id),
      ...routeSecurityOf(id),
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description: 'The asset id returned when the upload URL was minted.',
          schema: { type: 'string', pattern: '^ava_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Avatar recorded by this call, first or replacement.',
          content: avatarContent,
        },
        '200': {
          description:
            'This asset was already recorded as the Avatar by an earlier completion; the same Avatar is returned.',
          content: avatarContent,
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function avatarItemPathItem(): Record<string, unknown> {
  const read = 'me.avatar.read' as const;
  const remove = 'me.avatar.remove' as const;

  return {
    [PUBLIC_ROUTES[read].method.toLowerCase()]: {
      operationId: read,
      summary: 'Read the Avatar',
      description:
        'Describes the Avatar of the signed-in AIHUB User Account, or answers `avatar: null` when the account has none; that is a normal state, not an error. `url` is the published origin URL of the image: load it with a plain unauthenticated `GET`, which AIHUB does not proxy. Each upload has a new URL, and a removed image may stay in caches for up to an hour.',
      ...routeIdentityScopeOf(read),
      ...routeSecurityOf(read),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      responses: {
        [routeSuccessKeyOf(read)]: {
          description: 'The Avatar, or `null` when the account has none.',
          content: {
            'application/json': { schema: routeSchemaOf(read, 'response') },
          },
        },
        ...routeErrorResponsesOf(read),
      },
    },
    [PUBLIC_ROUTES[remove].method.toLowerCase()]: {
      operationId: remove,
      summary: 'Remove the Avatar',
      description:
        'Deletes the Avatar image and its record for the signed-in AIHUB User Account. Idempotent: an account with no Avatar also answers `204`. If the image cannot be deleted the account keeps its Avatar and the call answers `503`; retrying finishes the removal. `409 AVATAR_CHANGED` means another request replaced the Avatar meanwhile, and the replacement is kept.',
      ...routeIdentityScopeOf(remove),
      ...routeSecurityOf(remove),
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      responses: {
        [routeSuccessKeyOf(remove)]: {
          description: 'The account has no Avatar.',
        },
        ...routeErrorResponsesOf(remove),
      },
    },
  };
}

function speakingQuestionsPathItem(): Record<string, unknown> {
  const id = 'speaking.questions' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'List Speaking questions',
      ...routeSecurityOf(id),
      parameters: [
        {
          name: 'part',
          in: 'query',
          required: false,
          description: 'Filter by Speaking part; omit to list all parts.',
          schema: SpeakingQuestionsQuerySchema.properties.part,
        },
      ],
      responses: {
        '200': {
          description: 'Speaking questions and signed audio URLs',
          headers: {
            'Cache-Control': {
              description: 'This response must not be cached.',
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function speakingAudioUploadPathItems(): Record<
  string,
  Record<string, unknown>
> {
  const create = 'speaking.audioUploads.create' as const;
  const refresh = 'speaking.audioUploads.refresh' as const;
  const complete = 'speaking.audioUploads.complete' as const;
  const sharedParameters = [
    { $ref: '#/components/parameters/CorrelationId' },
    { $ref: '#/components/parameters/UserIdentity' },
  ];
  const assetIdParameter = {
    name: 'assetId',
    in: 'path',
    required: true,
    description: 'The asset ID returned when the upload intent was created.',
    schema: { type: 'string', pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$' },
  };
  const noStore = {
    'Cache-Control': {
      description: 'Upload URLs and Audio metadata must not be cached.',
      schema: { type: 'string', enum: ['no-store'] },
    },
  };
  const urlSchema = routeSchemaOf(create, 'response');
  const assetSchema = routeSchemaOf(complete, 'response');
  const urlResponses = (routeId: typeof create | typeof refresh) => ({
    [routeSuccessKeyOf(routeId)]: {
      description:
        'Returns the same server-generated key and signed headers for the upload intent.',
      headers: noStore,
      content: { 'application/json': { schema: urlSchema } },
    },
    ...routeErrorResponsesOf(routeId),
  });

  return {
    [routePathOf(create)]: {
      post: {
        operationId: create,
        summary: 'Create a Speaking Audio upload intent',
        description: [
          'Creates a one-hour intent bound to the Organization and exact End-User ID resolved from `X-User-Identity`. The response contains a five-minute presigned `PUT` URL; send the audio directly to that URL with the returned `Content-Type` and `Content-Length` headers.',
          'The URL is a write credential. Do not log, persist, or expose it. The intent is not an Audio asset until completion verifies the stored object.',
        ].join('\n\n'),
        ...routeIdentityScopeOf(create),
        ...routeSecurityOf(create),
        parameters: sharedParameters,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: routeSchemaOf(create, 'request') },
          },
        },
        responses: urlResponses(create),
      },
    },
    [routePathOf(refresh)]: {
      post: {
        operationId: refresh,
        summary: 'Refresh a Speaking Audio upload URL',
        description:
          'Issues another five-minute URL for the same open intent, key, content type, and byte size. It does not extend the original one-hour intent expiry.',
        ...routeIdentityScopeOf(refresh),
        ...routeSecurityOf(refresh),
        parameters: [...sharedParameters, assetIdParameter],
        responses: urlResponses(refresh),
      },
    },
    [routePathOf(complete)]: {
      post: {
        operationId: complete,
        summary: 'Complete a Speaking Audio upload',
        description: [
          'Verifies the stored object metadata at the exact key recorded by the intent. A valid object creates the Audio asset and sets `retention_expires_at` to 30 days after acceptance; a missing object leaves the intent retryable, while invalid metadata rejects the intent.',
          'Only the same Organization and End-User ID can complete the intent. Repeating a successful completion returns the same Audio asset.',
        ].join('\n\n'),
        ...routeIdentityScopeOf(complete),
        ...routeSecurityOf(complete),
        parameters: [...sharedParameters, assetIdParameter],
        responses: {
          [routeSuccessKeyOf(complete)]: {
            description: 'The verified Audio asset created by this request.',
            headers: noStore,
            content: { 'application/json': { schema: assetSchema } },
          },
          '200': {
            description:
              'This intent was already completed; the same Audio asset is returned.',
            headers: noStore,
            content: { 'application/json': { schema: assetSchema } },
          },
          ...routeErrorResponsesOf(complete),
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function addHeadOperations(paths: Record<string, unknown>): void {
  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem) || !isRecord(pathItem.get) || pathItem.head) {
      continue;
    }

    const getOperation = pathItem.get;
    const getResponses = isRecord(getOperation.responses)
      ? getOperation.responses
      : {};
    const responses = Object.fromEntries(
      Object.entries(getResponses).map(([status, response]) => {
        const headers = isRecord(response) ? response.headers : undefined;
        return [
          status,
          {
            description:
              status === '200'
                ? 'Success; same headers as GET, without a response body.'
                : 'Same status as GET, without a response body.',
            ...(headers === undefined ? {} : { headers }),
          },
        ];
      }),
    );

    pathItem.head = {
      ...getOperation,
      operationId: `${String(getOperation.operationId)}.head`,
      summary: 'Retrieve response headers',
      description:
        'Returns the same status and headers as GET without a response body.',
      responses,
    };
  }
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

  paths[routePathOf('sandbox.assertions.mint')] =
    sandboxAssertionPathItem(groupedErrors);
  paths[routePathOf('speaking.questions')] = speakingQuestionsPathItem();
  Object.assign(paths, speakingAudioUploadPathItems());
  paths[routePathOf('me.avatar.uploads.create')] = avatarUploadPathItem();
  paths[routePathOf('me.avatar.uploads.complete')] = avatarCompletePathItem();
  paths[routePathOf('me.avatar.remove')] = avatarItemPathItem();
  paths[routePathOf('organizations.create')] = organizationPathItem();
  paths[routePathOf('organizations.rename')] = organizationItemPathItem();
  paths[routePathOf('organizations.me.members.list')] =
    organizationRosterPathItem();
  paths[routePathOf('organizations.members.list')] =
    organizationMembershipListPathItem();
  paths[routePathOf('organizations.invitations.list')] =
    organizationInvitationPathItem();
  paths[routePathOf('organizations.invitations.revoke')] =
    organizationInvitationItemPathItem();
  paths[routePathOf('organizations.invitations.accept')] =
    organizationInvitationAcceptPathItem();
  paths[routePathOf('organizations.members.change_role')] =
    organizationMembershipMutationPathItem();
  paths[routePathOf('organizations.members.transfer')] =
    organizationMembershipTransferPathItem();
  paths[routePathOf('organizations.apiKeys.list')] =
    organizationApiKeyPathItem();
  paths[routePathOf('organizations.apiKeys.revoke')] =
    organizationApiKeyItemPathItem();
  paths[routePathOf('organizations.apiKeys.rotate')] =
    organizationApiKeyRotatePathItem();
  paths[routePathOf('organizations.identityConfig.read')] =
    organizationIdentityConfigPathItem();
  paths[routePathOf('organizations.auditEvents.list')] =
    organizationAuditEventPathItem();
  Object.assign(paths, localAuthPathItems());
  Object.assign(paths, webSessionPathItems());
  addHeadOperations(paths);

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
      title: 'AIHUB API',
      version,
    },
    servers: PUBLIC_API_SERVERS.map(({ hostname, description }) => ({
      url: `https://${hostname}`,
      description,
    })),
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
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'User Access JWT for protected user-facing routes.',
        },
        RefreshCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: REFRESH_COOKIE_NAME,
          description:
            'Host-only Secure HttpOnly cookie containing the opaque refresh credential.',
        },
        BffClientSecret: {
          type: 'apiKey',
          in: 'header',
          name: WEB_SESSION_CLIENT_SECRET_HEADER,
          description:
            'Server-to-server only, Customer Web BFF. Static client secret proving the caller is the AIHUB-owned Customer Web backend. Not a browser credential and not an Organization key: a browser never sends it, and these routes are not for a browser to call.',
        },
      },
      parameters: {
        CorrelationId: CORRELATION_ID_PARAMETER,
        UserIdentity: USER_IDENTITY_PARAMETER,
      },
      responses: errorResponses,
    },
    paths,
  };
}

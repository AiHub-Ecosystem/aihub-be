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
import {
  EmptyAuthRequestSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  ResendVerificationRequestSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
} from '../contracts/auth/local-auth';
import {
  CreateOrganizationApiKeyRequestSchema,
  ListOrganizationApiKeysResponseSchema,
  OrganizationApiKeySecretResponseSchema,
  RevokeOrganizationApiKeyResponseSchema,
} from '../contracts/organization/api-key';
import {
  AcceptOrganizationInvitationRequestSchema,
  AcceptOrganizationInvitationResponseSchema,
  CreateOrganizationInvitationRequestSchema,
  CreateOrganizationInvitationResponseSchema,
} from '../contracts/organization/invitation';
import {
  OrganizationMembershipMutationRequestSchema,
  OrganizationMembershipMutationResponseSchema,
  OrganizationRosterResponseSchema,
} from '../contracts/organization/membership';
import {
  MintSandboxAssertionRequestSchema,
  MintSandboxAssertionResponseSchema,
} from '../contracts/sandbox/assertion';
import { REFRESH_COOKIE_NAME } from '../modules/auth/presentation/refresh-cookie';

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

const SANDBOX_ASSERTION_PATH = '/v1/sandbox/assertions';
const AUTH_REGISTER_PATH = '/v1/auth/register';
const AUTH_LOGIN_PATH = '/v1/auth/login';
const AUTH_VERIFY_PATH = '/v1/auth/verify-email';
const AUTH_RESEND_PATH = '/v1/auth/resend-verification';
const AUTH_FORGOT_PASSWORD_PATH = '/v1/auth/forgot-password';
const AUTH_RESET_PASSWORD_PATH = '/v1/auth/reset-password';
const AUTH_REFRESH_PATH = '/v1/auth/refresh';
const AUTH_LOGOUT_PATH = '/v1/auth/logout';
const ORGANIZATION_ROSTER_PATH = '/v1/organizations/me/members';
const ORGANIZATION_INVITATION_PATH =
  '/v1/organizations/{organization_id}/invitations';
const ORGANIZATION_INVITATION_ACCEPT_PATH =
  '/v1/organizations/invitations/accept';
const ORGANIZATION_MEMBER_PATH =
  '/v1/organizations/{organization_id}/members/{username}';
const ORGANIZATION_MEMBER_TRANSFER_PATH =
  '/v1/organizations/{organization_id}/members/{username}/transfer';
const ORGANIZATION_API_KEY_PATH =
  '/v1/organizations/{organization_id}/api-keys';
const ORGANIZATION_API_KEY_ITEM_PATH =
  '/v1/organizations/{organization_id}/api-keys/{api_key_id}';
const ORGANIZATION_API_KEY_ROTATE_PATH =
  '/v1/organizations/{organization_id}/api-keys/{api_key_id}/rotate';

function authErrorResponses(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
  statuses: readonly HttpStatus[],
): Record<string, unknown> {
  return Object.fromEntries(
    statuses.map((status) => [
      String(status),
      { $ref: `#/components/responses/Error${status}` },
    ]),
  );
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

function localAuthPathItems(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, Record<string, unknown>> {
  // Keep auth responses intentionally narrow: these routes do not carry API
  // key, assertion, downstream, or idempotency behavior.
  const registerResponses = {
    '201': {
      description: 'Account created and pending email verification',
      content: { 'application/json': { schema: RegisterResponseSchema } },
    },
    ...authErrorResponses(groupedErrors, [400, 409, 429, 500, 503]),
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
    ...authErrorResponses(groupedErrors, [400, 401, 429, 500]),
  };
  const verifyResponses = {
    '204': { description: 'Email verified' },
    ...authErrorResponses(groupedErrors, [400, 429, 500]),
  };
  const resendResponses = {
    '202': { description: 'Verification resend accepted' },
    ...authErrorResponses(groupedErrors, [400, 429, 500]),
  };
  const forgotPasswordResponses = {
    '202': {
      description: 'Password recovery request accepted',
      content: {
        'application/json': { schema: ForgotPasswordResponseSchema },
      },
    },
    ...authErrorResponses(groupedErrors, [400, 429, 500]),
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
    ...authErrorResponses(groupedErrors, [400, 429, 500]),
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
    ...authErrorResponses(groupedErrors, [400, 429, 500]),
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
    ...authErrorResponses(groupedErrors, [400, 500]),
  };

  const operation = (
    operationId: string,
    summary: string,
    schema: TSchema,
    responses: Record<string, unknown>,
    security: readonly Record<string, readonly string[]>[] = [],
    requestBodyRequired = true,
  ): Record<string, unknown> => ({
    post: {
      operationId,
      summary,
      'x-identity-scope': 'none',
      security,
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: requestBodyRequired,
        content: { 'application/json': { schema } },
      },
      responses,
    },
  });

  return {
    [AUTH_REGISTER_PATH]: operation(
      'auth.register',
      'Register a local AIHUB account',
      RegisterRequestSchema,
      registerResponses,
    ),
    [AUTH_LOGIN_PATH]: operation(
      'auth.login',
      'Issue a User Access JWT',
      LoginRequestSchema,
      loginResponses,
    ),
    [AUTH_VERIFY_PATH]: operation(
      'auth.verify_email',
      'Verify a local account email address',
      VerifyEmailRequestSchema,
      verifyResponses,
    ),
    [AUTH_RESEND_PATH]: operation(
      'auth.resend_verification',
      'Request a verification email resend',
      ResendVerificationRequestSchema,
      resendResponses,
    ),
    [AUTH_FORGOT_PASSWORD_PATH]: operation(
      'auth.forgot_password',
      'Request a password reset email',
      ForgotPasswordRequestSchema,
      forgotPasswordResponses,
    ),
    [AUTH_RESET_PASSWORD_PATH]: operation(
      'auth.reset_password',
      'Reset a local account password',
      ResetPasswordRequestSchema,
      resetPasswordResponses,
    ),
    [AUTH_REFRESH_PATH]: operation(
      'auth.refresh',
      'Rotate a refresh session and issue a User Access JWT',
      EmptyAuthRequestSchema,
      refreshResponses,
      [{ RefreshCookie: [] }],
      false,
    ),
    [AUTH_LOGOUT_PATH]: operation(
      'auth.logout',
      'Revoke the current refresh session',
      EmptyAuthRequestSchema,
      logoutResponses,
      [{ RefreshCookie: [] }],
      false,
    ),
  };
}

function organizationInvitationAcceptPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  return {
    post: {
      operationId: 'organizations.invitations.accept',
      summary: 'Accept an organization invitation',
      'x-identity-scope': 'user',
      security: [{ BearerAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: AcceptOrganizationInvitationRequestSchema,
          },
        },
      },
      responses: {
        '200': {
          description: 'Organization membership granted or reactivated',
          content: {
            'application/json': {
              schema: AcceptOrganizationInvitationResponseSchema,
            },
          },
        },
        ...authErrorResponses(groupedErrors, [400, 401, 403, 500]),
      },
    },
  };
}

/**
 * Described by hand for the same reason as the roster: it is a management
 * route, not a catalogued proxy operation.
 */
function organizationInvitationPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  return {
    post: {
      operationId: 'organizations.invitations.create',
      summary: 'Invite a person to an organization',
      'x-identity-scope': 'user',
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
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
          'application/json': {
            schema: CreateOrganizationInvitationRequestSchema,
          },
        },
      },
      responses: {
        '201': {
          description:
            'Pending organization invitation created; the single-use invite credential reaches the invited person by email only',
          content: {
            'application/json': {
              schema: CreateOrganizationInvitationResponseSchema,
            },
          },
        },
        ...authErrorResponses(groupedErrors, [400, 401, 403, 409, 500, 503]),
      },
    },
  };
}

function organizationApiKeyItemPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  return {
    delete: {
      operationId: 'organizations.apiKeys.revoke',
      summary: 'Revoke an organization API key',
      description:
        'Withdraws the key and keeps its durable row, purging the identity cache so the change takes effect inside the existing cache ceiling. State-idempotent: withdrawing an already withdrawn key succeeds and leaves the recorded moment unchanged. This is the only response from which `revoked` is reachable.',
      'x-identity-scope': 'user',
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
        '200': {
          description: 'API key withdrawn; its durable row is kept',
          content: {
            'application/json': {
              schema: RevokeOrganizationApiKeyResponseSchema,
            },
          },
        },
        ...authErrorResponses(groupedErrors, [401, 403, 404, 500, 503]),
      },
    },
  };
}

function organizationApiKeyRotatePathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  return {
    post: {
      operationId: 'organizations.apiKeys.rotate',
      summary: 'Rotate an organization API key',
      description:
        'Creates a replacement and revokes the named key in one act, with no window in which both work. The replacement inherits the name, scopes, allowed environments, and expiry, and its raw credential is returned in this response only. A revoked or expired key cannot be rotated.',
      'x-identity-scope': 'user',
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
        '200': {
          description:
            'API key rotated; the raw replacement is returned in this response only and cannot be recovered afterwards. `status` is always `active`.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': {
              schema: OrganizationApiKeySecretResponseSchema,
            },
          },
        },
        ...authErrorResponses(groupedErrors, [401, 403, 404, 500, 503]),
      },
    },
  };
}

function organizationApiKeyPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  return {
    get: {
      operationId: 'organizations.apiKeys.list',
      summary: 'List an organization API key inventory',
      description:
        'Returns the organization live API keys as metadata only. Revoked keys are absent; `status` is `expired` once a key expiry has passed. `last_used_at` is approximate.',
      'x-identity-scope': 'user',
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
        '200': {
          description:
            'Live API key inventory; never a credential hash or raw credential',
          content: {
            'application/json': {
              schema: ListOrganizationApiKeysResponseSchema,
            },
          },
        },
        ...authErrorResponses(groupedErrors, [401, 403, 500, 503]),
      },
    },
    post: {
      operationId: 'organizations.apiKeys.create',
      summary: 'Create an organization API key',
      'x-identity-scope': 'user',
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
          'application/json': { schema: CreateOrganizationApiKeyRequestSchema },
        },
      },
      responses: {
        '201': {
          description:
            'API key created; the raw credential is returned in this response only and cannot be recovered afterwards. `status` is always `active`: a requested expiry must be in the future, so this response never carries `expired`.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': {
              schema: OrganizationApiKeySecretResponseSchema,
            },
          },
        },
        ...authErrorResponses(groupedErrors, [400, 401, 403, 500, 503]),
      },
    },
  };
}

function organizationRosterPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  return {
    get: {
      operationId: 'organizations.me.members.list',
      summary: 'List the authenticated user organization roster',
      'x-identity-scope': 'user',
      security: [{ BearerAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      responses: {
        '200': {
          description: 'Organization roster',
          content: {
            'application/json': { schema: OrganizationRosterResponseSchema },
          },
        },
        ...authErrorResponses(groupedErrors, [401, 403, 500]),
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

function organizationMembershipMutationPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  const success = {
    description: 'The resulting organization membership',
    content: {
      'application/json': {
        schema: OrganizationMembershipMutationResponseSchema,
      },
    },
  };

  return {
    patch: {
      operationId: 'organizations.members.change_role',
      summary: 'Change an organization member role',
      'x-identity-scope': 'user',
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: OrganizationMembershipMutationRequestSchema,
          },
        },
      },
      responses: {
        '200': success,
        ...authErrorResponses(groupedErrors, [400, 401, 403, 404, 409, 500]),
      },
    },
    delete: {
      operationId: 'organizations.members.disable',
      summary: 'Disable an organization member',
      'x-identity-scope': 'user',
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      responses: {
        '200': success,
        ...authErrorResponses(groupedErrors, [400, 401, 403, 404, 409, 500]),
      },
    },
  };
}

function organizationMembershipTransferPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
  return {
    post: {
      operationId: 'organizations.members.transfer',
      summary: 'Transfer organization ownership',
      'x-identity-scope': 'user',
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      responses: {
        '200': {
          description: 'The resulting organization membership',
          content: {
            'application/json': {
              schema: OrganizationMembershipMutationResponseSchema,
            },
          },
        },
        ...authErrorResponses(groupedErrors, [400, 401, 403, 404, 409, 500]),
      },
    },
  };
}

/**
 * Described by hand rather than from `OPERATION_CATALOG`, because it is not a
 * catalog operation: it has no downstream service, no downstream contract, and
 * no scope. Adding a synthetic entry to reuse the generator would put a
 * phantom proxy operation in front of every reader of this document.
 *
 * The envelope is narrower than a proxied operation's for the same reason. A
 * dispatch envelope reports downstream and gateway timings for a call that
 * reached an AI service; this one reaches none, and publishing zeroed timings
 * would describe a measurement nobody took.
 */
function sandboxAssertionPathItem(
  groupedErrors: ReadonlyMap<HttpStatus, readonly ErrorCode[]>,
): Record<string, unknown> {
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

  for (const status of groupedErrors.keys()) {
    // No idempotency, so no conflict to report.
    if (status === 409) {
      continue;
    }
    responses[String(status)] = {
      $ref: `#/components/responses/Error${status}`,
    };
  }

  return {
    post: {
      operationId: 'sandbox.assertions.mint',
      summary: 'Mint a sandbox user assertion',
      description: [
        'Issues a short-lived user assertion for the sandbox organization, so that exercising the API does not require holding an organization signing key.',
        'Available only to API keys belonging to a configured sandbox organization; every other key is refused. Deployments with no sandbox configured answer 404.',
        'This is not the integration pattern for a customer with their own backend. Such a customer signs assertions from their own identity provider and never calls this route.',
      ].join('\n\n'),
      'x-identity-scope': 'organization',
      security: [{ ApiKeyAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: MintSandboxAssertionRequestSchema },
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

  paths[SANDBOX_ASSERTION_PATH] = sandboxAssertionPathItem(groupedErrors);
  paths[ORGANIZATION_ROSTER_PATH] = organizationRosterPathItem(groupedErrors);
  paths[ORGANIZATION_INVITATION_PATH] =
    organizationInvitationPathItem(groupedErrors);
  paths[ORGANIZATION_INVITATION_ACCEPT_PATH] =
    organizationInvitationAcceptPathItem(groupedErrors);
  paths[ORGANIZATION_MEMBER_PATH] =
    organizationMembershipMutationPathItem(groupedErrors);
  paths[ORGANIZATION_MEMBER_TRANSFER_PATH] =
    organizationMembershipTransferPathItem(groupedErrors);
  paths[ORGANIZATION_API_KEY_PATH] = organizationApiKeyPathItem(groupedErrors);
  paths[ORGANIZATION_API_KEY_ITEM_PATH] =
    organizationApiKeyItemPathItem(groupedErrors);
  paths[ORGANIZATION_API_KEY_ROTATE_PATH] =
    organizationApiKeyRotatePathItem(groupedErrors);
  Object.assign(paths, localAuthPathItems(groupedErrors));

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

import { OPERATION_CATALOG } from '../catalog/operation-catalog';
import { OPERATION_IDS } from '../catalog/operation-id';
import { buildOpenApiDocument } from './build-openapi-document';

interface OpenApiResponse {
  readonly headers?: Record<string, { readonly schema?: unknown }>;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly parameters: readonly Record<string, unknown>[];
  readonly requestBody: {
    readonly required?: boolean;
    readonly content: Record<string, { readonly schema: unknown }>;
  };
  readonly responses: Record<string, OpenApiResponse | undefined>;
  readonly security?: readonly Record<string, readonly string[]>[];
  // Optional because the sandbox mint route carries no scope: it is not a
  // catalogued operation and has nothing to authorize against.
  readonly 'x-required-scope'?: string;
  readonly 'x-identity-scope': string;
  readonly 'x-idempotency'?: string;
}

interface OpenApiPathItem {
  readonly get?: OpenApiOperation;
  readonly post?: OpenApiOperation;
  readonly patch?: OpenApiOperation;
  readonly delete?: OpenApiOperation;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly security: readonly Record<string, readonly string[]>[];
  readonly components: {
    readonly securitySchemes: Record<string, unknown>;
    readonly parameters: Record<string, unknown>;
    readonly responses: Record<string, unknown>;
  };
  readonly paths: Record<string, OpenApiPathItem>;
}

const SANDBOX_MINT_PATH = '/v1/sandbox/assertions';
const SANDBOX_MINT_OPERATION_ID = 'sandbox.assertions.mint';
const ORGANIZATION_PATH = '/v1/organizations';
const ORGANIZATION_CREATE_OPERATION_ID = 'organizations.create';
const ORGANIZATION_ITEM_PATH = '/v1/organizations/{organization_id}';
const ORGANIZATION_ROSTER_PATH = '/v1/organizations/me/members';
const ORGANIZATION_ROSTER_OPERATION_ID = 'organizations.me.members.list';
const ORGANIZATION_INVITATION_PATH =
  '/v1/organizations/{organization_id}/invitations';
const ORGANIZATION_INVITATION_ITEM_PATH =
  '/v1/organizations/{organization_id}/invitations/{invitation_id}';
const ORGANIZATION_INVITATION_OPERATION_ID = 'organizations.invitations.create';
const ORGANIZATION_INVITATION_LIST_OPERATION_ID =
  'organizations.invitations.list';
const ORGANIZATION_INVITATION_REVOKE_OPERATION_ID =
  'organizations.invitations.revoke';
const ORGANIZATION_INVITATION_ACCEPT_PATH =
  '/v1/organizations/invitations/accept';
const ORGANIZATION_INVITATION_ACCEPT_OPERATION_ID =
  'organizations.invitations.accept';
const ORGANIZATION_MEMBER_PATH =
  '/v1/organizations/{organization_id}/members/{username}';
const ORGANIZATION_MEMBER_TRANSFER_PATH =
  '/v1/organizations/{organization_id}/members/{username}/transfer';
const ORGANIZATION_API_KEY_PATH =
  '/v1/organizations/{organization_id}/api-keys';
const ORGANIZATION_API_KEY_OPERATION_ID = 'organizations.apiKeys.create';
const ORGANIZATION_API_KEY_LIST_OPERATION_ID = 'organizations.apiKeys.list';
const ORGANIZATION_API_KEY_ITEM_PATH =
  '/v1/organizations/{organization_id}/api-keys/{api_key_id}';
const ORGANIZATION_API_KEY_REVOKE_OPERATION_ID = 'organizations.apiKeys.revoke';
const ORGANIZATION_API_KEY_ROTATE_PATH =
  '/v1/organizations/{organization_id}/api-keys/{api_key_id}/rotate';
const ORGANIZATION_API_KEY_ROTATE_OPERATION_ID = 'organizations.apiKeys.rotate';
const ORGANIZATION_AUDIT_EVENT_PATH =
  '/v1/organizations/{organization_id}/audit-events';
const ORGANIZATION_AUDIT_EVENT_OPERATION_ID = 'organizations.auditEvents.list';
const ORGANIZATION_MEMBER_CHANGE_ROLE_OPERATION_ID =
  'organizations.members.change_role';
const ORGANIZATION_MEMBER_DISABLE_OPERATION_ID =
  'organizations.members.disable';
const ORGANIZATION_MEMBER_TRANSFER_OPERATION_ID =
  'organizations.members.transfer';
const AUTH_PATHS = [
  '/v1/auth/register',
  '/v1/auth/login',
  '/v1/auth/verify-email',
  '/v1/auth/resend-verification',
  '/v1/auth/forgot-password',
  '/v1/auth/reset-password',
  '/v1/auth/refresh',
  '/v1/auth/logout',
] as const;
const AUTH_OPERATION_IDS = [
  'auth.register',
  'auth.login',
  'auth.verify_email',
  'auth.resend_verification',
  'auth.forgot_password',
  'auth.reset_password',
  'auth.refresh',
  'auth.logout',
] as const;

function build(): OpenApiDocument {
  return buildOpenApiDocument('0.0.0-test') as OpenApiDocument;
}

describe('buildOpenApiDocument', () => {
  it('declares OpenAPI 3.1', () => {
    expect(build().openapi).toBe('3.1.0');
  });

  it('has exactly one path entry per catalogued operation, so adding an operation without regenerating fails', () => {
    const doc = build();
    const operationIds = Object.values(doc.paths)
      .flatMap((item) =>
        item.post === undefined ? [] : [item.post.operationId],
      )
      .filter(
        (operationId) =>
          operationId !== SANDBOX_MINT_OPERATION_ID &&
          operationId !== ORGANIZATION_CREATE_OPERATION_ID &&
          operationId !== ORGANIZATION_INVITATION_OPERATION_ID &&
          operationId !== ORGANIZATION_INVITATION_ACCEPT_OPERATION_ID &&
          operationId !== ORGANIZATION_MEMBER_TRANSFER_OPERATION_ID &&
          operationId !== ORGANIZATION_API_KEY_OPERATION_ID &&
          operationId !== ORGANIZATION_API_KEY_ROTATE_OPERATION_ID &&
          !AUTH_OPERATION_IDS.includes(
            operationId as (typeof AUTH_OPERATION_IDS)[number],
          ),
      );

    expect(operationIds.sort()).toEqual([...OPERATION_IDS].sort());
    expect(operationIds).toHaveLength(OPERATION_IDS.length);
  });

  it('publishes the explicit sandbox and local-auth paths off the catalog', () => {
    const doc = build();
    const catalogued = new Set<string>(
      OPERATION_IDS.map((operationId) => OPERATION_CATALOG[operationId].path),
    );

    expect(
      Object.keys(doc.paths).filter((path) => !catalogued.has(path)),
    ).toEqual([
      SANDBOX_MINT_PATH,
      ORGANIZATION_PATH,
      ORGANIZATION_ITEM_PATH,
      ORGANIZATION_ROSTER_PATH,
      ORGANIZATION_INVITATION_PATH,
      ORGANIZATION_INVITATION_ITEM_PATH,
      ORGANIZATION_INVITATION_ACCEPT_PATH,
      ORGANIZATION_MEMBER_PATH,
      ORGANIZATION_MEMBER_TRANSFER_PATH,
      ORGANIZATION_API_KEY_PATH,
      ORGANIZATION_API_KEY_ITEM_PATH,
      ORGANIZATION_API_KEY_ROTATE_PATH,
      ORGANIZATION_AUDIT_EVENT_PATH,
      ...AUTH_PATHS,
    ]);
    expect(doc.paths[SANDBOX_MINT_PATH]?.post?.operationId).toBe(
      SANDBOX_MINT_OPERATION_ID,
    );
  });

  it('documents the bearer-authenticated invitation acceptance route', () => {
    const operation = build().paths[ORGANIZATION_INVITATION_ACCEPT_PATH]?.post;

    expect(operation?.operationId).toBe(
      ORGANIZATION_INVITATION_ACCEPT_OPERATION_ID,
    );
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.requestBody).toBeDefined();
    expect(operation?.responses['200']).toBeDefined();
    expect(operation?.responses['400']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
    // The organization is an attribute of the redeemed invitation, so the
    // route takes no organization parameter at all.
    expect(operation?.parameters).toEqual([
      { $ref: '#/components/parameters/CorrelationId' },
    ]);
  });

  it('documents the bearer-authenticated organization invitation route', () => {
    const operation = build().paths[ORGANIZATION_INVITATION_PATH]?.post;

    expect(operation?.operationId).toBe(ORGANIZATION_INVITATION_OPERATION_ID);
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.requestBody).toBeDefined();
    expect(operation?.responses['201']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
    expect(operation?.responses['409']).toBeDefined();
    expect(operation?.responses['429']).toBeDefined();
    expect(operation?.responses['503']).toBeDefined();
    expect(operation?.['x-idempotency']).toBe('optional');
    expect(operation?.parameters).toEqual([
      { $ref: '#/components/parameters/CorrelationId' },
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
      }),
      expect.objectContaining({
        name: 'organization_id',
        in: 'path',
        required: true,
      }),
    ]);
    expect(operation?.responses['201']).toHaveProperty(
      'headers.Idempotent-Replay',
    );
    // The raw Organization Invite Token belongs to the invited person.
    expect(JSON.stringify(operation?.responses['201'])).not.toContain('token');
  });

  it('documents bodyless bearer-authenticated invitation revocation', () => {
    const operation = build().paths[ORGANIZATION_INVITATION_ITEM_PATH]?.delete;

    expect(operation?.operationId).toBe(
      ORGANIZATION_INVITATION_REVOKE_OPERATION_ID,
    );
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.responses['204']).toBeDefined();
    expect(operation?.responses['401']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
    expect(operation?.responses['404']).toBeDefined();
    expect(operation?.responses['500']).toBeDefined();
    expect(operation?.responses['204']).not.toHaveProperty('content');
    expect(operation?.parameters).toEqual([
      { $ref: '#/components/parameters/CorrelationId' },
      expect.objectContaining({
        name: 'organization_id',
        in: 'path',
        required: true,
      }),
      expect.objectContaining({
        name: 'invitation_id',
        in: 'path',
        required: true,
      }),
    ]);
  });

  it('documents the organization path parameter for the invitation route', () => {
    const operation = build().paths[ORGANIZATION_INVITATION_PATH]?.post;

    expect(operation?.parameters).toEqual([
      { $ref: '#/components/parameters/CorrelationId' },
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
      }),
      expect.objectContaining({
        name: 'organization_id',
        in: 'path',
        required: true,
      }),
    ]);
  });

  it('documents the bearer-authenticated open invitation listing route', () => {
    const operation = build().paths[ORGANIZATION_INVITATION_PATH]?.get;

    expect(operation?.operationId).toBe(
      ORGANIZATION_INVITATION_LIST_OPERATION_ID,
    );
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.parameters).toEqual([
      { $ref: '#/components/parameters/CorrelationId' },
      expect.objectContaining({
        name: 'organization_id',
        in: 'path',
        required: true,
      }),
    ]);
    expect(operation?.requestBody).toBeUndefined();
    expect(operation?.responses['200']).toBeDefined();
    expect(operation?.responses['401']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
    expect(operation?.responses['500']).toBeDefined();
    expect(JSON.stringify(operation?.responses['200'])).not.toContain(
      'token_hash',
    );
  });

  it('documents the bearer-authenticated organization roster route', () => {
    const operation = build().paths[ORGANIZATION_ROSTER_PATH]?.get;

    expect(operation?.operationId).toBe(ORGANIZATION_ROSTER_OPERATION_ID);
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.parameters).toEqual([
      { $ref: '#/components/parameters/CorrelationId' },
    ]);
    expect(operation?.requestBody).toBeUndefined();
    expect(operation?.responses['200']).toBeDefined();
    expect(JSON.stringify(operation?.responses['200'])).not.toContain('email');
  });

  it('documents the bearer-authenticated API key creation route as uncacheable', () => {
    const operation = build().paths[ORGANIZATION_API_KEY_PATH]?.post;

    expect(operation?.operationId).toBe(ORGANIZATION_API_KEY_OPERATION_ID);
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.requestBody?.required).toBe(true);
    // The response carries a credential disclosed exactly once, so the
    // published contract has to say no cache may keep a copy of it.
    expect(
      operation?.responses['201']?.headers?.['Cache-Control']?.schema,
    ).toEqual({ type: 'string', enum: ['no-store'] });
    expect(operation?.responses['403']).toBeDefined();
  });

  it('documents the bearer-authenticated API key listing route without a cache header', () => {
    const operation = build().paths[ORGANIZATION_API_KEY_PATH]?.get;

    expect(operation?.operationId).toBe(ORGANIZATION_API_KEY_LIST_OPERATION_ID);
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.requestBody).toBeUndefined();
    // Unlike creation, this response carries no credential, so it declares no
    // no-store header.
    expect(operation?.responses['200']?.headers).toBeUndefined();
    expect(operation?.responses['403']).toBeDefined();
    expect(JSON.stringify(operation?.responses['200'])).not.toContain(
      'api_key"',
    );
  });

  it('documents the audit trail read, the first route here to carry query parameters', () => {
    const operation = build().paths[ORGANIZATION_AUDIT_EVENT_PATH]?.get;
    const parameters = operation?.parameters ?? [];
    const named = (name: string) =>
      parameters.find((parameter) => parameter?.name === name);

    expect(operation?.operationId).toBe(ORGANIZATION_AUDIT_EVENT_OPERATION_ID);
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.requestBody).toBeUndefined();

    // The server reads a repeated key, so a client that comma-joined these
    // would send something no parameter here accepts.
    expect(named('action')?.explode).toBe(true);
    expect(named('action')?.style).toBe('form');
    expect(named('action')?.schema).toEqual({
      type: 'array',
      items: {
        type: 'string',
        enum: expect.arrayContaining(['api_key.revoked']),
      },
    });
    expect(named('outcome')?.schema).toEqual({
      type: 'string',
      enum: ['applied', 'denied'],
    });
    expect(named('limit')?.schema).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 50,
    });
    for (const name of ['from', 'to', 'cursor']) {
      expect(named(name)?.in).toBe('query');
    }

    // A rejected cursor, window, action, or page size is a client error, so
    // this is the only organization read that documents a 400.
    expect(operation?.responses['400']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
  });

  it('documents the bearer-authenticated API key rotation route as uncacheable', () => {
    const operation = build().paths[ORGANIZATION_API_KEY_ROTATE_PATH]?.post;

    expect(operation?.operationId).toBe(
      ORGANIZATION_API_KEY_ROTATE_OPERATION_ID,
    );
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    // Rotation takes no body: what it does is fixed by the route.
    expect(operation?.requestBody).toBeUndefined();
    expect(
      operation?.responses['200']?.headers?.['Cache-Control']?.schema,
    ).toEqual({ type: 'string', enum: ['no-store'] });
    // An unknown key and another tenant's key share this status on purpose.
    expect(operation?.responses['404']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
  });

  it('documents the bearer-authenticated API key revocation route', () => {
    const operation = build().paths[ORGANIZATION_API_KEY_ITEM_PATH]?.delete;

    expect(operation?.operationId).toBe(
      ORGANIZATION_API_KEY_REVOKE_OPERATION_ID,
    );
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.requestBody).toBeUndefined();
    // No credential in the body, so no no-store, unlike creation and rotation.
    expect(operation?.responses['200']?.headers).toBeUndefined();
    expect(operation?.responses['404']).toBeDefined();
    expect(JSON.stringify(operation?.responses['200'])).not.toContain(
      'api_key"',
    );
  });

  it('documents the owner-only rename route as a name-only PATCH', () => {
    const rename = build().paths[ORGANIZATION_ITEM_PATH]?.patch;

    expect(rename?.operationId).toBe('organizations.rename');
    expect(rename?.security).toEqual([{ BearerAuth: [] }]);
    expect(rename?.requestBody?.required).toBe(true);
    expect(rename?.responses['200']).toBeDefined();
    expect(rename?.responses['403']).toBeDefined();
    const body = JSON.stringify(rename?.requestBody);
    expect(body).toContain('"additionalProperties":false');
    expect(body).not.toContain('quota');
    expect(JSON.stringify(rename)).not.toContain('Idempotency-Key');
  });

  it('documents the bearer-authenticated member mutation routes', () => {
    const member = build().paths[ORGANIZATION_MEMBER_PATH];
    const transfer = build().paths[ORGANIZATION_MEMBER_TRANSFER_PATH]?.post;

    expect(member?.patch?.operationId).toBe(
      ORGANIZATION_MEMBER_CHANGE_ROLE_OPERATION_ID,
    );
    expect(member?.delete?.operationId).toBe(
      ORGANIZATION_MEMBER_DISABLE_OPERATION_ID,
    );
    expect(transfer?.operationId).toBe(
      ORGANIZATION_MEMBER_TRANSFER_OPERATION_ID,
    );
    expect(member?.patch?.security).toEqual([{ BearerAuth: [] }]);
    expect(member?.delete?.security).toEqual([{ BearerAuth: [] }]);
    expect(transfer?.security).toEqual([{ BearerAuth: [] }]);
    expect(member?.patch?.requestBody?.required).toBe(true);
    expect(member?.delete?.requestBody).toBeUndefined();
    expect(transfer?.requestBody).toBeUndefined();
    expect(member?.patch?.responses['200']).toBeDefined();
    expect(member?.delete?.responses['400']).toBeDefined();
    expect(member?.delete?.responses['409']).toBeDefined();
    expect(transfer?.responses['409']).toBeDefined();
    expect(JSON.stringify(member?.patch?.requestBody)).toContain('admin');
    expect(JSON.stringify(member?.patch?.requestBody)).not.toContain('owner');
  });

  it('documents local auth as unauthenticated and keeps token/password fields out of responses', () => {
    const doc = build();
    const register = doc.paths['/v1/auth/register']?.post;
    const login = doc.paths['/v1/auth/login']?.post;
    const verify = doc.paths['/v1/auth/verify-email']?.post;
    const resend = doc.paths['/v1/auth/resend-verification']?.post;
    const forgot = doc.paths['/v1/auth/forgot-password']?.post;
    const reset = doc.paths['/v1/auth/reset-password']?.post;
    const refresh = doc.paths['/v1/auth/refresh']?.post;
    const logout = doc.paths['/v1/auth/logout']?.post;

    expect(register?.security).toEqual([]);
    expect(login?.security).toEqual([]);
    expect(login?.responses['200']).toBeDefined();
    expect(JSON.stringify(login?.responses['200'])).toContain('no-store');
    expect(JSON.stringify(login?.responses['200'])).not.toContain('password');
    expect(register?.responses['201']).toBeDefined();
    expect(verify?.responses['204']).toBeDefined();
    expect(resend?.responses['202']).toBeDefined();
    expect(forgot?.security).toEqual([]);
    expect(forgot?.responses['202']).toBeDefined();
    expect(JSON.stringify(forgot?.responses['202'])).toContain('message');
    expect(reset?.security).toEqual([]);
    expect(reset?.responses['204']).toBeDefined();
    expect(JSON.stringify(reset?.responses['204'])).toContain('no-store');
    expect(JSON.stringify(reset?.responses['204'])).toContain('Set-Cookie');
    expect(refresh?.security).toEqual([{ RefreshCookie: [] }]);
    expect(refresh?.requestBody?.required).toBe(false);
    expect(refresh?.responses['200']).toBeDefined();
    expect(JSON.stringify(refresh?.responses['200'])).toContain('Set-Cookie');
    expect(JSON.stringify(refresh?.responses['401'])).toContain(
      'AUTH_REFRESH_TOKEN_INVALID',
    );
    expect(JSON.stringify(refresh?.responses['401'])).not.toContain(
      'AUTH_CREDENTIALS_INVALID',
    );
    expect(logout?.security).toEqual([{ RefreshCookie: [] }]);
    expect(logout?.requestBody?.required).toBe(false);
    expect(logout?.responses['204']).toBeDefined();
    expect(JSON.stringify(register?.responses['201'])).not.toContain(
      'password',
    );
    expect(JSON.stringify(register?.responses['201'])).not.toContain('token');
  });

  it('mints without an assertion, because issuing one is what it does', () => {
    const mint = build().paths[SANDBOX_MINT_PATH]?.post;
    const parameterRefs = (mint?.parameters ?? []).map(
      (parameter) => parameter.$ref,
    );

    expect(parameterRefs).not.toContain(
      '#/components/parameters/UserAssertion',
    );
    expect(mint?.['x-identity-scope']).toBe('organization');
    expect(mint?.['x-required-scope']).toBeUndefined();
  });

  it('uses the exact public path the catalog declares, with no duplicated version prefix', () => {
    const doc = build();

    for (const operationId of OPERATION_IDS) {
      const catalogued = OPERATION_CATALOG[operationId];
      const pathItem = doc.paths[catalogued.path];

      expect(pathItem).toBeDefined();
      expect(pathItem?.post?.operationId).toBe(operationId);
      expect(catalogued.path).toMatch(/^\/v1\//);
      expect(catalogued.path).not.toMatch(/^\/v1\/v1\//);
    }
  });

  it('embeds the exact request and response schema objects from the catalog', () => {
    const doc = build();
    const operation = doc.paths['/v1/ielts/writing/task1/grade']?.post;
    const catalogued = OPERATION_CATALOG['writing.task1.grade'];

    expect(operation?.requestBody.content['application/json']?.schema).toBe(
      catalogued.requestSchema,
    );
  });

  it('carries the required scope, identity scope, and idempotency mode as vendor extensions', () => {
    const doc = build();
    const operation = doc.paths['/v1/ielts/writing/task1/grade']?.post;

    expect(operation?.['x-required-scope']).toBe('writing.grade');
    expect(operation?.['x-identity-scope']).toBe('user');
    expect(operation?.['x-idempotency']).toBe('required');
  });

  it('documents an ignored Idempotency-Key parameter for an operation catalogued as none', () => {
    const doc = build();
    const operation = doc.paths['/v1/ielts/speaking/grading']?.post;
    const names = operation?.parameters.map(
      (parameter) => parameter.name ?? parameter.$ref,
    );

    expect(names).toContain('Idempotency-Key');
    expect(
      operation?.parameters.find(
        (parameter) => parameter.name === 'Idempotency-Key',
      ),
    ).toMatchObject({
      required: false,
      description: expect.stringContaining('Ignored'),
    });
  });

  it('marks Idempotency-Key required for grading operations', () => {
    const doc = build();
    const required = doc.paths[
      '/v1/ielts/writing/task1/grade'
    ]?.post?.parameters.find(
      (parameter) => parameter.name === 'Idempotency-Key',
    );
    const none = doc.paths['/v1/ielts/speaking/grading']?.post?.parameters.find(
      (parameter) => parameter.name === 'Idempotency-Key',
    );

    expect(required?.required).toBe(true);
    expect(none?.required).toBe(false);
  });

  it('references the correlation id header on every operation', () => {
    const doc = build();

    for (const operationId of OPERATION_IDS) {
      const path = OPERATION_CATALOG[operationId].path;
      const refs = doc.paths[path]?.post?.parameters.map(
        (parameter) => parameter.$ref,
      );

      expect(refs).toContain('#/components/parameters/CorrelationId');
    }
  });

  it('requires a user assertion only for user-scoped operations', () => {
    const userParameters =
      build().paths['/v1/ielts/writing/task1/grade']?.post?.parameters;
    const speakingParameters =
      build().paths['/v1/ielts/speaking/grading']?.post?.parameters;

    expect(userParameters).toContainEqual({
      $ref: '#/components/parameters/UserAssertion',
    });
    expect(speakingParameters).toContainEqual({
      $ref: '#/components/parameters/UserAssertion',
    });
    expect(build().components.parameters.UserAssertion).toMatchObject({
      name: 'X-User-Assertion',
      in: 'header',
      required: true,
    });
  });

  it('declares the organization API key as a security scheme, not a bare header parameter', () => {
    const doc = build();

    expect(doc.components.securitySchemes.ApiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(doc.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(doc.components.securitySchemes.BearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('documents every error code actually reachable in the current runtime', () => {
    const doc = build();
    const operation = doc.paths['/v1/ielts/writing/task1/grade']?.post;

    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(
      [
        '200',
        '409',
        '400',
        '401',
        '403',
        '404',
        '413',
        '429',
        '500',
        '502',
        '503',
        '504',
      ].sort(),
    );
    expect(doc.components.responses.Error503).toBeDefined();
    expect(doc.components.responses.Error404).toBeDefined();
    expect(doc.components.responses.Error409).toBeDefined();
    expect(JSON.stringify(doc.components.responses.Error404)).toContain(
      'NOT_FOUND',
    );
    expect(JSON.stringify(doc.components.responses.Error429)).toContain(
      'CONCURRENCY_LIMIT',
    );
  });

  it('documents stable retry fields on every error response', () => {
    const doc = build();
    const response = doc.components.responses.Error429;

    expect(response).toMatchObject({
      content: {
        'application/json': {
          schema: {
            properties: {
              error: {
                properties: {
                  retryable: { type: 'boolean' },
                  retry_after_ms: { type: 'integer', minimum: 0 },
                },
                required: expect.arrayContaining([
                  'code',
                  'message',
                  'request_id',
                  'retryable',
                ]),
              },
            },
          },
        },
      },
    });

    const schema = response as {
      readonly content: {
        readonly 'application/json': {
          readonly schema: {
            readonly properties: {
              readonly error: {
                readonly required: readonly string[];
              };
            };
          };
        };
      };
    };
    expect(
      schema.content['application/json'].schema.properties.error.required,
    ).not.toContain('retry_after_ms');
  });

  it('documents the replay marker on required idempotent success responses', () => {
    const operation = build().paths['/v1/ielts/writing/task1/grade']?.post;
    const success = operation?.responses['200'] as {
      readonly headers?: Record<string, unknown>;
    };

    expect(success.headers?.['Idempotent-Replay']).toMatchObject({
      schema: { type: 'string', enum: ['true'] },
    });
  });

  it('does not advertise idempotency conflicts for operations catalogued as none', () => {
    const operation = build().paths['/v1/ielts/speaking/grading']?.post;

    expect(operation?.responses['409']).toBeUndefined();
  });

  it('takes the document version from the caller rather than hardcoding one', () => {
    expect(
      (buildOpenApiDocument('9.9.9') as OpenApiDocument).info.version,
    ).toBe('9.9.9');
  });
});

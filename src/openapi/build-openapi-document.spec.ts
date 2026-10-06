import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { OPERATION_IDS, isOperationId } from '@/catalog/operation-id';
import { PUBLIC_ROUTES, isPublicRouteId } from '@/catalog/public-routes';
import { buildOpenApiDocument } from './build-openapi-document';
import { toOpenApiPath } from './openapi-path';

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
  readonly description?: string;
  readonly security?: readonly Record<string, readonly string[]>[];
  // Optional because the sandbox mint route carries no scope: it is not a
  // catalogued operation and has nothing to authorize against.
  readonly 'x-required-scope'?: string;
  readonly 'x-identity-scope': string;
  readonly 'x-idempotency'?: string;
}

interface OpenApiPathItem {
  readonly get?: OpenApiOperation;
  readonly head?: OpenApiOperation;
  readonly put?: OpenApiOperation;
  readonly post?: OpenApiOperation;
  readonly patch?: OpenApiOperation;
  readonly delete?: OpenApiOperation;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly servers: readonly {
    readonly url: string;
    readonly description: string;
  }[];
  readonly security: readonly Record<string, readonly string[]>[];
  readonly components: {
    readonly securitySchemes: Record<string, unknown>;
    readonly parameters: Record<string, unknown>;
    readonly responses: Record<string, unknown>;
  };
  readonly paths: Record<string, OpenApiPathItem>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const OPENAPI_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]);

function requestProperty(
  operation: OpenApiOperation | undefined,
  property: string,
): Record<string, unknown> | undefined {
  const schema = operation?.requestBody.content['application/json']?.schema;
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return undefined;
  }
  const value = schema.properties[property];
  return isRecord(value) ? value : undefined;
}

const SANDBOX_MINT_PATH = '/v1/sandbox/assertions';
const SPEAKING_QUESTIONS_PATH = '/v1/ielts/speaking/questions';
const SANDBOX_MINT_OPERATION_ID = 'sandbox.assertions.mint';
const ORGANIZATION_ITEM_PATH = '/v1/organizations/{organization_id}';
const ORGANIZATION_ROSTER_OPERATION_ID = 'organizations.me.members.list';
const ORGANIZATION_ROSTER_PATH = toOpenApiPath(
  PUBLIC_ROUTES[ORGANIZATION_ROSTER_OPERATION_ID].path,
);
const ORGANIZATION_MEMBERSHIP_LIST_PATH = toOpenApiPath(
  PUBLIC_ROUTES['organizations.members.list'].path,
);
const ORGANIZATION_MEMBERSHIP_LIST_OPERATION_ID = 'organizations.members.list';
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
const ORGANIZATION_IDENTITY_CONFIG_PATH =
  '/v1/organizations/{organization_id}/identity-config';
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

function build(): OpenApiDocument {
  return buildOpenApiDocument('0.0.0-test') as OpenApiDocument;
}

describe('buildOpenApiDocument', () => {
  it('declares OpenAPI 3.1', () => {
    expect(build().openapi).toBe('3.1.0');
  });

  it('publishes the Production and Sandbox servers', () => {
    expect(build().servers).toEqual([
      {
        url: 'https://api.aihubproduction.com',
        description: 'Production API',
      },
      {
        url: 'https://sandbox.aihubproduction.com',
        description: 'Sandbox API for testing',
      },
    ]);
    expect(build().servers).not.toHaveLength(0);
  });

  it('has exactly one path entry per catalogued operation, so adding an operation without regenerating fails', () => {
    const doc = build();
    const postOperationIds = Object.values(doc.paths).flatMap((item) =>
      item.post === undefined ? [] : [item.post.operationId],
    );

    // The two registries partition the Public API Routes, so deciding which
    // document operation is which needs no hand-written list. A post operation
    // declared in neither registry is the drift this catches.
    const undeclared = postOperationIds.filter(
      (operationId) =>
        !isOperationId(operationId) && !isPublicRouteId(operationId),
    );
    const dispatchOperationIds = postOperationIds.filter((operationId) =>
      isOperationId(operationId),
    );

    expect(undeclared).toEqual([]);
    expect(dispatchOperationIds.sort()).toEqual([...OPERATION_IDS].sort());
    expect(dispatchOperationIds).toHaveLength(OPERATION_IDS.length);
  });

  it('documents every non-dispatch route from the registry, and nothing else off the catalog', () => {
    const doc = build();
    const dispatchPaths = new Set<string>(
      OPERATION_IDS.map((operationId) => OPERATION_CATALOG[operationId].path),
    );
    const declared = new Set(
      Object.values(PUBLIC_ROUTES).map((route) => toOpenApiPath(route.path)),
    );

    expect(
      Object.keys(doc.paths)
        .filter((path) => !dispatchPaths.has(path))
        .sort(),
    ).toEqual([...declared].sort());
    expect(doc.paths[SANDBOX_MINT_PATH]?.post?.operationId).toBe(
      SANDBOX_MINT_OPERATION_ID,
    );
  });

  /**
   * `callerAuth` and the published `security` entry are declared in two places:
   * the registry, and the path item the builder renders. The auth, sandbox, and
   * Speaking-question path items derive `security` from the registry, so for
   * those eleven the comparison below re-states `routeSecurityOf` and proves
   * nothing. Its value is the eighteen organization path items, which still
   * hand-write `security: [{ BearerAuth: [] }]`; nothing else joins the two, so
   * changing an organization route's `callerAuth` would have published a
   * document still claiming BearerAuth.
   *
   * `security` must be present and explicit, not merely correct when present.
   * The document declares a root-level default of `[{ ApiKeyAuth: [] }]`, which
   * OpenAPI makes every operation inherit unless it declares its own. A
   * `callerAuth: 'none'` route whose explicit `security: []` went missing
   * would therefore publish as ApiKeyAuth while reading as unset here, so both
   * the missing route and the missing key fail this test.
   */
  /**
   * `x-identity-scope` used to be twenty hand-written literals in this builder.
   * The registry now records what the document publishes, and the builder
   * derives the extension from it.
   *
   * This test therefore does **not** prove the recorded value is the right one:
   * for the twenty-seven routes whose path item calls `routeIdentityScopeOf`,
   * changing the registry changes the document too, and the two agree by
   * construction. What it proves is that no path item has stopped calling the
   * helper — the one route that omits the extension on purpose
   * (`speaking.questions`, recorded as `null`) fails this test the moment it
   * starts publishing one. That is the drift mode worth catching; whether the
   * recorded values should change is a separate decision, and ADR-0059 leaves
   * it open.
   */
  /**
   * The rule the extension has to obey, asserted against the document rather
   * than against the registry: an operation publishes `x-identity-scope:
   * user` if and only if it publishes the `X-User-Identity` parameter.
   *
   * This is the check that would have caught the drift it now guards. The
   * eighteen Organization routes used to publish `user` while consuming no User
   * Identity at all, telling a generated client to send a header the route
   * rejects. Unlike the test above, nothing here re-states a registry value, so
   * it fails when the document and the header disagree — which is the whole
   * point of publishing the extension.
   */
  it('publishes x-identity-scope user only where it also publishes the User Identity parameter', () => {
    const doc = build();
    const violations: Record<string, string> = {};

    for (const [path, pathItem] of Object.entries(doc.paths)) {
      if (!isRecord(pathItem)) {
        continue;
      }

      for (const [method, operation] of Object.entries(pathItem)) {
        if (!OPENAPI_METHODS.has(method) || !isRecord(operation)) {
          continue;
        }

        const parameters = Array.isArray(operation.parameters)
          ? operation.parameters
          : [];
        const consumesUserIdentity = parameters.some(
          (parameter) =>
            isRecord(parameter) &&
            parameter.$ref === '#/components/parameters/UserIdentity',
        );
        const claimsUser = operation['x-identity-scope'] === 'user';

        if (claimsUser !== consumesUserIdentity) {
          violations[`${method.toUpperCase()} ${path}`] =
            `claims=${claimsUser} consumes=${consumesUserIdentity}`;
        }
      }
    }

    expect(violations).toEqual({});
  });

  it('publishes the x-identity-scope value the registry records', () => {
    const doc = build();
    const mismatches: Record<string, unknown> = {};

    for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
      const pathItem = doc.paths[toOpenApiPath(route.path)];
      const operation = pathItem?.[
        route.method.toLowerCase() as keyof OpenApiPathItem
      ] as (OpenApiOperation & Record<string, unknown>) | undefined;

      const published =
        operation === undefined
          ? 'missing-route'
          : (operation['x-identity-scope'] ?? null);

      if (published !== route.publishedIdentityScope) {
        mismatches[routeId] = {
          declared: route.publishedIdentityScope,
          published,
        };
      }
    }

    expect(mismatches).toEqual({});
  });

  /**
   * A `null` response schema means a bodyless success, and a non-null one means
   * the document publishes that schema as the success content. Neither may
   * mean "no contract module was written yet": that is how
   * `speaking.questions` spent its life, with its envelope inlined in this
   * builder and its shape restated as a TypeScript interface in a controller,
   * so the registry could not name the response it published.
   *
   * Checked here rather than in the catalog spec because the rule is about the
   * document: a 202 may or may not carry a body, so the status alone cannot
   * decide it, but whether the path item emitted `content` can.
   */
  it('publishes a success body exactly when the registry declares a response schema', () => {
    const doc = build();
    const mismatches: Record<string, string> = {};

    for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
      const pathItem = doc.paths[toOpenApiPath(route.path)];
      const operation = pathItem?.[
        route.method.toLowerCase() as keyof OpenApiPathItem
      ] as
        | (OpenApiOperation & { responses?: Record<string, unknown> })
        | undefined;

      const success = operation?.responses?.[String(route.successStatus)] as
        | { content?: unknown }
        | undefined;
      const publishesBody = success?.content !== undefined;

      if (publishesBody !== (route.responseSchema !== null)) {
        mismatches[routeId] =
          `publishesBody=${publishesBody} declaresSchema=${route.responseSchema !== null}`;
      }
    }

    expect(mismatches).toEqual({});
  });

  it('publishes an explicit security scheme matching each route callerAuth', () => {
    const schemeFor: Record<string, string> = {
      bearer: 'BearerAuth',
      'api-key': 'ApiKeyAuth',
      'refresh-cookie': 'RefreshCookie',
      none: '',
    };

    const doc = build();
    const mismatches: Record<string, unknown> = {};

    for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
      const pathItem = doc.paths[toOpenApiPath(route.path)];
      const operation = pathItem?.[
        route.method.toLowerCase() as keyof OpenApiPathItem
      ] as (OpenApiOperation & { security?: unknown }) | undefined;

      if (operation === undefined) {
        mismatches[routeId] = { reason: 'route is missing from the document' };
        continue;
      }
      if (operation.security === undefined) {
        mismatches[routeId] = {
          reason: 'inherits the root ApiKeyAuth default',
        };
        continue;
      }

      const published = operation.security as readonly Record<
        string,
        readonly string[]
      >[];
      const expected = schemeFor[route.callerAuth];
      const actual = published
        .map((entry) => Object.keys(entry)[0] ?? '')
        .join(',');

      if (actual !== expected) {
        mismatches[routeId] = {
          callerAuth: route.callerAuth,
          published: actual,
        };
      }
    }

    expect(mismatches).toEqual({});
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
    // No 503: an email provider failure is no longer a synchronous result here.
    expect(operation?.responses['503']).toBeUndefined();
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
    expect(JSON.stringify(operation?.responses['200'])).toContain(
      '"entitlements":{"type":"array","items":{"minLength":1,"type":"string"}}',
    );
    expect(JSON.stringify(operation?.responses['200'])).not.toContain('email');
  });

  it('documents the organization membership list contract and filter', () => {
    const operation = build().paths[ORGANIZATION_MEMBERSHIP_LIST_PATH]?.get;

    expect(operation?.operationId).toBe(
      ORGANIZATION_MEMBERSHIP_LIST_OPERATION_ID,
    );
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.parameters).toEqual([
      { $ref: '#/components/parameters/CorrelationId' },
      expect.objectContaining({
        name: 'organization_id',
        in: 'path',
        required: true,
      }),
      expect.objectContaining({
        name: 'status',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          enum: ['active', 'disabled'],
          default: 'active',
        },
      }),
    ]);
    expect(operation?.responses['200']).toBeDefined();
    expect(operation?.responses['400']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
    expect(JSON.stringify(operation?.responses['200'])).toContain('username');
    expect(JSON.stringify(operation?.responses['200'])).not.toContain('email');
    expect(JSON.stringify(operation?.responses['200'])).not.toContain(
      'user_account_id',
    );
  });

  it('documents the owner-only identity configuration save contract and errors', () => {
    const operation = build().paths[ORGANIZATION_IDENTITY_CONFIG_PATH]?.put;

    expect(operation?.operationId).toBe('organizations.identityConfig.set');
    expect(operation?.security).toEqual([{ BearerAuth: [] }]);
    expect(operation?.requestBody?.required).toBe(true);
    expect(operation?.responses['200']).toBeDefined();
    expect(operation?.responses['400']).toBeDefined();
    expect(operation?.responses['403']).toBeDefined();
    expect(operation?.responses['409']).toBeDefined();
    expect(operation?.responses['503']).toBeDefined();
    expect(JSON.stringify(operation?.requestBody)).toContain('jwks_url');
    expect(JSON.stringify(operation?.requestBody)).toContain(
      'public_keys_jwks',
    );
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

  it('documents Verification Sign-in on verify-email and the optional Signup Browser Binding', () => {
    const doc = build();
    const verify = doc.paths['/v1/auth/verify-email']?.post;

    expect(Object.keys(verify?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '204']),
    );
    expect(JSON.stringify(verify?.responses?.['200'])).toContain('Set-Cookie');
    for (const path of [
      '/v1/auth/register',
      '/v1/auth/resend-verification',
      '/v1/auth/verify-email',
    ]) {
      expect(
        requestProperty(doc.paths[path]?.post, 'browser_binding'),
      ).toMatchObject({ type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' });
    }
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

    for (const operation of [register, login, reset]) {
      const password = requestProperty(operation, 'password');
      expect(password).toMatchObject({
        type: 'string',
        minLength: 12,
        maxLength: 128,
        description: '12–128 Unicode code points; no normalization.',
      });
      expect(password?.format).toBeUndefined();
    }

    expect(login?.responses['409']).toBeUndefined();
    expect(verify?.responses['409']).toBeUndefined();
    expect(resend?.responses['409']).toBeUndefined();
    expect(forgot?.responses['409']).toBeUndefined();
    expect(reset?.responses['409']).toBeUndefined();
    expect(refresh?.responses['409']).toBeUndefined();
    expect(logout?.responses['409']).toBeUndefined();
    expect(register?.security).toEqual([]);
    expect(login?.security).toEqual([]);
    expect(login?.responses['200']).toBeDefined();
    expect(JSON.stringify(login?.responses['200'])).toContain('no-store');
    expect(JSON.stringify(login?.responses['200'])).not.toContain('password');
    expect(register?.responses['201']).toBeDefined();
    expect(verify?.responses['204']).toBeDefined();
    expect(JSON.stringify(verify?.responses['204'])).toContain(
      'same unexpired token that activated',
    );
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

    expect(parameterRefs).not.toContain('#/components/parameters/UserIdentity');
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

  it('requires a user identity only for user-scoped operations', () => {
    const userParameters =
      build().paths['/v1/ielts/writing/task1/grade']?.post?.parameters;
    const speakingParameters =
      build().paths['/v1/ielts/speaking/grading']?.post?.parameters;

    expect(userParameters).toContainEqual({
      $ref: '#/components/parameters/UserIdentity',
    });
    expect(speakingParameters).toContainEqual({
      $ref: '#/components/parameters/UserIdentity',
    });
    expect(build().components.parameters.UserIdentity).toMatchObject({
      name: 'X-User-Identity',
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
    expect(JSON.stringify(doc.components.responses.Error403)).not.toContain(
      'IDENTITY_CONFIG_REQUIRED',
    );
  });

  // The outbox took provider delivery out of the request (ADR-0074), so the
  // code those four flows used to raise has no producer left and the two routes
  // that advertised it have no 503 to answer with.
  it('publishes no error code the outbox left without a producer', () => {
    const doc = build();

    expect(JSON.stringify(doc)).not.toContain(
      'AUTH_EMAIL_DELIVERY_UNAVAILABLE',
    );
    expect(
      doc.paths['/v1/auth/register']?.post?.responses['503'],
    ).toBeUndefined();
    expect(
      doc.paths[ORGANIZATION_INVITATION_PATH]?.post?.responses['503'],
    ).toBeUndefined();
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

  it('documents the unauthenticated Speaking questions route as implemented', () => {
    const operation = build().paths[SPEAKING_QUESTIONS_PATH]?.get;
    const partParameter = operation?.parameters.find(
      (parameter) => parameter.name === 'part',
    );
    const success = operation?.responses['200'] as {
      readonly headers?: Record<string, unknown>;
      readonly content?: Record<string, { readonly schema: unknown }>;
    };
    const responseSchema = JSON.stringify(
      success?.content?.['application/json']?.schema,
    );

    expect(operation).toMatchObject({
      operationId: 'speaking.questions',
      security: [],
    });
    expect(partParameter).toMatchObject({
      name: 'part',
      in: 'query',
      required: false,
    });
    expect(JSON.stringify(partParameter?.schema)).toContain('"1"');
    expect(JSON.stringify(partParameter?.schema)).toContain('"2"');
    expect(JSON.stringify(partParameter?.schema)).toContain('"3"');
    expect(responseSchema).toContain('"part"');
    expect(responseSchema).toContain('"questions"');
    expect(responseSchema).toContain('"question_id"');
    expect(responseSchema).toContain('"prompt_text"');
    expect(responseSchema).toContain('"audio_url"');
    expect(responseSchema).toContain('"request_id"');
    expect(responseSchema).toContain('"speaking.questions"');
    expect(responseSchema).not.toContain('"timing"');
    expect(success?.headers?.['Cache-Control']).toBeDefined();
    expect(operation?.responses['400']).toBeDefined();
    expect(operation?.responses['500']).toBeDefined();
  });

  it('documents Speaking Audio intent ownership, direct upload, refresh, and completion', () => {
    const paths = build().paths;
    const create = paths['/v1/speaking/audio/uploads']?.post;
    const refresh =
      paths['/v1/speaking/audio/uploads/{asset_id}/refresh']?.post;
    const complete =
      paths['/v1/speaking/audio/uploads/{asset_id}/complete']?.post;

    expect(create).toMatchObject({
      operationId: 'speaking.audioUploads.create',
      security: [{ ApiKeyAuth: [] }],
      'x-identity-scope': 'user',
    });
    expect(create?.parameters).toContainEqual({
      $ref: '#/components/parameters/UserIdentity',
    });
    expect(create?.description).toContain('five-minute');
    expect(create?.responses['201']?.headers?.['Cache-Control']).toBeDefined();
    expect(create?.responses['503']).toBeDefined();

    expect(refresh).toMatchObject({
      operationId: 'speaking.audioUploads.refresh',
      security: [{ ApiKeyAuth: [] }],
    });
    expect(refresh?.parameters).toContainEqual(
      expect.objectContaining({ name: 'assetId', in: 'path', required: true }),
    );
    expect(refresh?.responses['200']).toBeDefined();
    expect(refresh?.responses['404']).toBeDefined();

    expect(complete).toMatchObject({
      operationId: 'speaking.audioUploads.complete',
      security: [{ ApiKeyAuth: [] }],
    });
    expect(complete?.responses['201']).toBeDefined();
    expect(complete?.responses['200']).toBeDefined();
    expect(complete?.description).toContain('30 days');
  });

  it('documents every GET route HEAD variant without a response body', () => {
    const paths = build().paths;

    for (const pathItem of Object.values(paths)) {
      if (pathItem?.get === undefined) {
        continue;
      }

      const head = pathItem.head;
      expect(head).toMatchObject({
        operationId: `${pathItem.get.operationId}.head`,
        security: pathItem.get.security,
      });

      for (const response of Object.values(head?.responses ?? {})) {
        expect(response).not.toHaveProperty('content');
      }
    }
  });

  it('takes the document version from the caller rather than hardcoding one', () => {
    expect(
      (buildOpenApiDocument('9.9.9') as OpenApiDocument).info.version,
    ).toBe('9.9.9');
  });
});

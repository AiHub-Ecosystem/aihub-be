import { runInNewContext } from 'node:vm';
import type { CollectionDefinition } from 'postman-collection';
import { Collection } from 'postman-collection';

import { buildOpenApiDocument } from '@/openapi/build-openapi-document';
import {
  buildPostmanCollection,
  preservePostmanIds,
} from './build-postman-collection';

interface PostmanItemGroup {
  readonly name: string;
  readonly item?: readonly PostmanItem[];
}

interface PostmanItem {
  readonly name: string;
  readonly request?: {
    readonly url: unknown;
    readonly description?: string;
    readonly header?: readonly {
      readonly key: string;
      readonly value: string;
    }[];
    readonly auth?: unknown;
    readonly cookie?: readonly {
      readonly key: string;
      readonly value: string;
      readonly path?: string;
      readonly secure?: boolean;
      readonly httpOnly?: boolean;
    }[];
  };
  readonly event?: readonly {
    readonly script: { readonly exec: readonly string[] };
  }[];
  readonly item?: readonly PostmanItem[];
}

async function build(): Promise<Record<string, unknown>> {
  const openApiDocument = buildOpenApiDocument('0.0.0-test');
  return (await buildPostmanCollection(
    openApiDocument,
    '0.0.0-test',
  )) as Record<string, unknown>;
}

function findD1Folder(collection: Record<string, unknown>): PostmanItemGroup {
  const item = collection.item as readonly PostmanItemGroup[];
  const folder = item.find((entry) =>
    entry.name.startsWith('D1 handover test cases'),
  );
  if (folder === undefined) {
    throw new Error('D1 handover folder missing');
  }
  return folder;
}

function findIdempotencyFolder(
  collection: Record<string, unknown>,
): PostmanItemGroup {
  const item = collection.item as readonly PostmanItemGroup[];
  const folder = item.find(
    (entry) => entry.name === 'Idempotency mode examples',
  );
  if (folder === undefined) {
    throw new Error('idempotency examples folder missing');
  }
  return folder;
}

function findConcurrencyFolder(
  collection: Record<string, unknown>,
): PostmanItemGroup {
  const item = collection.item as readonly PostmanItemGroup[];
  const folder = item.find(
    (entry) => entry.name === 'Concurrency limit examples',
  );
  if (folder === undefined) {
    throw new Error('concurrency examples folder missing');
  }
  return folder;
}

describe('buildPostmanCollection', () => {
  it('parses as a well-formed Postman Collection v2.1, the same check Postman itself runs on import', async () => {
    const collection = await build();

    expect(
      () => new Collection(collection as CollectionDefinition),
    ).not.toThrow();
  });

  it('declares baseUrl and apiKey as collection variables', async () => {
    const collection = await build();
    const variables = collection.variable as readonly {
      key: string;
      value: string;
    }[];
    const names = variables.map((v) => v.key);

    expect(names).toContain('baseUrl');
    expect(names).toContain('apiKey');
    expect(names).toContain('refreshToken');
    expect(
      variables.find((variable) => variable.key === 'baseUrl')?.value,
    ).toBe('https://api.aihubproduction.com');
  });

  it('represents refresh and logout credentials as a Postman cookie, not a header', async () => {
    const collection = await build();
    const items = collection.item as readonly PostmanItem[];
    const refresh = items.find(
      (item) =>
        item.name === 'Rotate a refresh session and issue a User Access JWT',
    );
    const logout = items.find(
      (item) => item.name === 'Revoke the current refresh session',
    );

    for (const item of [refresh, logout]) {
      expect(item?.request?.auth).toBeUndefined();
      expect(item?.request?.header).not.toContainEqual(
        expect.objectContaining({ key: '__Host-aihub_refresh' }),
      );
      expect(item?.request?.cookie).toContainEqual({
        key: '__Host-aihub_refresh',
        value: '{{refreshToken}}',
        path: '/',
        secure: true,
        httpOnly: true,
      });
    }
  });

  it('includes unauthenticated local-auth requests from the OpenAPI contract', async () => {
    const collection = await build();
    const items = collection.item as readonly PostmanItemGroup[];
    const names = items.map((item) => item.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'Register a local AIHUB account',
        'Verify a local account email address',
        'Request a verification email resend',
        'Request a password reset email',
        'Reset a local account password',
      ]),
    );
  });

  async function verificationScript(): Promise<string> {
    const collection = await build();
    const items = collection.item as readonly PostmanItem[];
    const folder = items.find(
      (item) =>
        item.name === 'Customer Web Web Sessions (server-to-server, BFF only)',
    );
    const script = folder?.item?.find(
      (item) =>
        item.name === 'Create a Web Session from a Verification Sign-in',
    )?.event?.[0]?.script.exec;
    if (script === undefined)
      throw new Error('BFF verification script missing');
    return script.join('\n');
  }

  function runVerificationScript(
    script: string,
    code: number,
    payload: string,
  ): void {
    runInNewContext(
      script,
      {
        pm: {
          response: {
            code,
            json: () => JSON.parse(payload),
            text: () => payload,
          },
          test: (_name: string, test: () => void) => test(),
          expect: (value: unknown) => ({
            to: {
              be: {
                oneOf: (accepted: readonly unknown[]) =>
                  expect(accepted).toContain(value),
                a: (type: string) => expect(typeof value).toBe(type),
              },
              eql: (expected: unknown) => expect(value).toEqual(expected),
            },
          }),
        },
      },
      { timeout: 1_000 },
    );
  }

  it.each([
    [
      201,
      JSON.stringify({
        data: {
          web_session_token: 'opaque-token',
          expires_at: '2026-11-07T00:00:00.000Z',
        },
      }),
    ],
    [204, ''],
  ])(
    'executes the generated BFF verification test for accepted status %i',
    async (code, payload) => {
      const script = await verificationScript();
      expect(() => runVerificationScript(script, code, payload)).not.toThrow();
    },
  );

  it.each([
    [200, '{}', 'toContain'],
    [400, '{"error":{"code":"AUTH_VERIFICATION_TOKEN_INVALID"}}', 'toContain'],
    [201, '{"data":{}}', 'toBe'],
    [204, '{"data":{"web_session_token":"unexpected"}}', 'toEqual'],
  ])(
    'fails the generated BFF verification test for invalid response %i %s',
    async (code, payload, message) => {
      const script = await verificationScript();
      expect(() => runVerificationScript(script, code, payload)).toThrow(
        message,
      );
    },
  );

  it('documents saved identity readiness without exposing JWKS configuration', async () => {
    const collection = await build();
    const items = collection.item as readonly PostmanItem[];
    const roster = items.find(
      (item) => item.name === 'List the authenticated user organization roster',
    );
    const script = roster?.event?.[0]?.script.exec.join('\n') ?? '';

    expect(roster?.request?.description).toContain('entitlement names');
    expect(roster?.request?.description).toContain(
      'does not probe the JWKS source',
    );
    expect(script).toContain('organization.entitlements');
    expect(script).toContain("typeof value === 'string'");
    expect(script).toContain('organization.identity_configured');
    expect(script).toContain("property('jwks_url')");
  });

  it('has 17 D1 handover test cases including the post-freeze issue #156 case', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);

    expect(folder.item).toHaveLength(17); // 2 happy-path sub-cases + items 2-16
  });

  it('grades with a Declared User ID for an Organization without identity configuration', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);
    const scenario = folder.item?.find(
      (item) =>
        item.name ===
        '16. Declared User ID for an Organization without identity configuration',
    );
    const headers = scenario?.request?.header ?? [];
    const script = scenario?.event?.[0]?.script.exec.join('\n') ?? '';
    const variables = collection.variable as readonly { key: string }[];

    expect(variables.map((variable) => variable.key)).toEqual(
      expect.arrayContaining(['declaredIdentityApiKey', 'declaredUserId']),
    );
    expect(variables.map((variable) => variable.key)).not.toContain(
      'identityConfigRequiredApiKey',
    );
    expect(scenario?.request?.url).toBe(
      '{{baseUrl}}/v1/ielts/writing/task1/grade',
    );
    expect(headers).toContainEqual({
      key: 'X-API-Key',
      value: '{{declaredIdentityApiKey}}',
    });
    expect(headers).toContainEqual({
      key: 'X-User-Identity',
      value: '{{declaredUserId}}',
    });
    expect(script).toContain('responds with HTTP 200');
    expect(script).not.toContain('IDENTITY_CONFIG_REQUIRED');
  });

  it('names internal metering on every deferred telemetry case', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);
    const blocked = (folder.item ?? []).filter((item) =>
      item.name.includes('BLOCKED'),
    );

    expect(blocked).toHaveLength(2); // items 13, 14

    for (const item of blocked) {
      const exec = item.event?.[0]?.script.exec.join('\n') ?? '';
      expect(exec).toMatch(/metering/);
    }
  });

  it('sends the user identity on user-scoped grading scenarios and checks a missing one', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);
    const task1Grade = folder.item?.find(
      (item) => item.name === '1a. Valid request routes to Task 1 grading',
    );
    const missingIdentity = folder.item?.find(
      (item) => item.name === '7. User-scoped operation missing User Identity',
    );

    expect(task1Grade?.request?.header).toContainEqual({
      key: 'X-User-Identity',
      value: '{{userIdentity}}',
    });
    expect(missingIdentity?.event?.[0]?.script.exec.join('\n')).toContain(
      'USER_IDENTITY_REQUIRED',
    );
  });

  it('includes the required idempotency examples', async () => {
    const collection = await build();
    const folder = findIdempotencyFolder(collection);

    expect(folder.item).toHaveLength(2);
    expect(folder.item?.map((item) => item.name)).toEqual([
      'Task 2 grading replays a completed result',
      'Task 2 grading rejects a conflicting payload',
    ]);

    const conflict = folder.item?.[1];
    expect(conflict?.event?.[0]?.script.exec.join('\n')).toContain(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('includes a reachable CONCURRENCY_LIMIT handover scenario', async () => {
    const collection = await build();
    const folder = findConcurrencyFolder(collection);

    expect(folder.item).toHaveLength(1);
    expect(folder.item?.[0]?.request?.url).toBe(
      '{{baseUrl}}/v1/ielts/writing/task1/grade',
    );
    expect(folder.item?.[0]?.event?.[0]?.script.exec.join('\n')).toContain(
      'CONCURRENCY_LIMIT',
    );
  });
});

describe('preservePostmanIds', () => {
  it('keeps IDs for existing collection items and leaves new item IDs intact', () => {
    const previous = {
      info: { _postman_id: 'existing-collection-id' },
      item: [
        {
          id: 'existing-folder-id',
          name: 'Organizations',
          item: [
            {
              id: 'existing-request-id',
              name: 'List members',
              request: {
                method: 'GET',
                url: {
                  path: ['v1', 'organizations', ':organizationId', 'members'],
                },
              },
            },
          ],
        },
      ],
    };
    const generated = {
      info: { _postman_id: 'new-collection-id' },
      item: [
        {
          id: 'new-folder-id',
          name: 'Organizations',
          item: [
            {
              id: 'new-request-id',
              name: 'List members',
              request: {
                method: 'GET',
                url: {
                  path: ['v1', 'organizations', ':organizationId', 'members'],
                },
              },
            },
            {
              id: 'generated-new-request-id',
              name: 'Create member',
              request: {
                method: 'POST',
                url: {
                  path: ['v1', 'organizations', ':organizationId', 'members'],
                },
              },
            },
          ],
        },
      ],
    };

    const result = preservePostmanIds(generated, previous) as typeof generated;

    expect(result.info._postman_id).toBe('existing-collection-id');
    expect(result.item[0]?.id).toBe('existing-folder-id');
    expect(result.item[0]?.item[0]?.id).toBe('existing-request-id');
    expect(result.item[0]?.item[1]?.id).toBe('generated-new-request-id');
  });
});

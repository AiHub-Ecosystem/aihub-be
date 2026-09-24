import type { CollectionDefinition } from 'postman-collection';
import { Collection } from 'postman-collection';

import { buildOpenApiDocument } from '../openapi/build-openapi-document';
import { buildPostmanCollection } from './build-postman-collection';

interface PostmanItemGroup {
  readonly name: string;
  readonly item?: readonly PostmanItem[];
}

interface PostmanItem {
  readonly name: string;
  readonly request?: {
    readonly url: unknown;
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
    const names = (collection.variable as readonly { key: string }[]).map(
      (v) => v.key,
    );

    expect(names).toContain('baseUrl');
    expect(names).toContain('apiKey');
    expect(names).toContain('refreshToken');
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

  it('has 17 D1 handover test cases including the post-freeze issue #156 case', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);

    expect(folder.item).toHaveLength(17); // 2 happy-path sub-cases + items 2-16
  });

  it('documents the 403 response when organization identity config is missing or disabled', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);
    const scenario = folder.item?.find(
      (item) => item.name === '16. Missing or disabled identity configuration',
    );
    const headers = scenario?.request?.header ?? [];
    const script = scenario?.event?.[0]?.script.exec.join('\n') ?? '';
    const variables = collection.variable as readonly { key: string }[];

    expect(variables.map((variable) => variable.key)).toContain(
      'identityConfigRequiredApiKey',
    );
    expect(scenario?.request?.url).toBe(
      '{{baseUrl}}/v1/ielts/writing/task1/grade',
    );
    expect(headers).toContainEqual({
      key: 'X-API-Key',
      value: '{{identityConfigRequiredApiKey}}',
    });
    expect(headers).toContainEqual({
      key: 'X-User-Assertion',
      value: '{{userAssertion}}',
    });
    expect(script).toContain('responds with HTTP 403');
    expect(script).toContain('IDENTITY_CONFIG_REQUIRED');
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

  it('uses a valid assertion for user-scoped grading scenarios and checks missing assertion', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);
    const task1Grade = folder.item?.find(
      (item) => item.name === '1a. Valid request routes to Task 1 grading',
    );
    const missingAssertion = folder.item?.find(
      (item) => item.name === '7. User-scoped operation missing User Assertion',
    );

    expect(task1Grade?.request?.header).toContainEqual({
      key: 'X-User-Assertion',
      value: '{{userAssertion}}',
    });
    expect(missingAssertion?.event?.[0]?.script.exec.join('\n')).toContain(
      'USER_ASSERTION_REQUIRED',
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

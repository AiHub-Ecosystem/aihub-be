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
  });

  it('has exactly 18 D1 handover test cases (4 happy-path sub-cases + items 2-15), matching §G of the D1 contract doc', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);

    expect(folder.item).toHaveLength(18); // 4 happy-path sub-cases for item 1 + items 2-15
  });

  it('names the blocking slice on every case that cannot pass yet', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);
    const blocked = (folder.item ?? []).filter((item) =>
      item.name.includes('BLOCKED'),
    );

    expect(blocked).toHaveLength(2); // items 13, 14

    for (const item of blocked) {
      const exec = item.event?.[0]?.script.exec.join('\n') ?? '';
      expect(exec).toMatch(/#9|#10/);
    }
  });

  it('uses a valid assertion for user-scoped grading scenarios and checks missing assertion', async () => {
    const collection = await build();
    const folder = findD1Folder(collection);
    const task1Grade = folder.item?.find(
      (item) => item.name === '1c. Valid request routes to Task 1 grading',
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
});

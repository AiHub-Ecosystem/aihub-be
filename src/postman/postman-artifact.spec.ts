import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CollectionDefinition } from 'postman-collection';
import { Collection } from 'postman-collection';

import {
  buildPostmanCollection,
  preservePostmanIds,
} from './build-postman-collection';

const REPO_ROOT = join(__dirname, '../..');
const COLLECTION_PATH = join(REPO_ROOT, 'aihub.postman_collection.json');
const OPENAPI_PATH = join(REPO_ROOT, 'openapi.json');

function committedCollection(): unknown {
  return JSON.parse(readFileSync(COLLECTION_PATH, 'utf8'));
}

function committedOpenApiDocument(): unknown {
  return JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
}

function packageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as {
    version: string;
  };
  return packageJson.version;
}

describe('committed aihub.postman_collection.json', () => {
  it('matches generated OpenAPI content and preserves existing Postman IDs', async () => {
    const committed = committedCollection();
    const generated = await buildPostmanCollection(
      committedOpenApiDocument(),
      packageVersion(),
    );
    const fresh = preservePostmanIds(generated, committed);

    expect(committed).toEqual(fresh);
  });

  it('parses as a well-formed Postman Collection v2.1 — the same check Postman itself runs on import', () => {
    expect(
      () => new Collection(committedCollection() as CollectionDefinition),
    ).not.toThrow();
  });

  it('keeps the organization invitation rate-limit handover scenario', async () => {
    const generated = JSON.stringify(
      await buildPostmanCollection(
        committedOpenApiDocument(),
        packageVersion(),
      ),
    );

    expect(generated).toContain('Organization invitation send rate limit');
    expect(generated).toContain('responds with HTTP 429');
    expect(generated).toContain('RATE_LIMITED');
  });

  it('gives the Web Session routes their own folder with a fake BFF secret', () => {
    interface PostmanEntry {
      readonly name?: string;
      readonly request?: { readonly header?: { key: string; value: string }[] };
      readonly item?: PostmanEntry[];
    }
    interface PostmanCollection {
      readonly item?: PostmanEntry[];
      readonly variable?: { key: string; value: string }[];
    }

    const collection = committedCollection() as PostmanCollection;
    const folder = collection.item?.find(
      (entry) =>
        entry.name === 'Customer Web Web Sessions (server-to-server, BFF only)',
    );
    expect(folder).toBeDefined();

    expect((folder?.item ?? []).map((entry) => entry.name)).toEqual([
      'Create a Web Session from a password login',
      'Create a Web Session from a Verification Sign-in',
      'Exchange a Web Session for a User Access JWT',
      'Logout a Web Session',
    ]);

    // The folder is the only surface that authenticates with the BFF secret, so
    // every request in it must carry the header. The value stays a variable
    // reference, never an inline literal: the real secret comes from Vault and
    // must not be committable from here.
    const secret = collection.variable?.find(
      (entry) => entry.key === 'webSessionClientSecret',
    );
    expect(secret?.value).toBe(
      'REPLACE_WITH_THE_CUSTOMER_WEB_BFF_CLIENT_SECRET',
    );

    for (const entry of folder?.item ?? []) {
      expect(entry.request?.header).toContainEqual({
        key: 'X-AIHUB-Client-Secret',
        value: '{{webSessionClientSecret}}',
      });
    }
  });

  it('keeps infrastructure health endpoints out of the generated collection', async () => {
    const generated = JSON.stringify(
      await buildPostmanCollection(
        committedOpenApiDocument(),
        packageVersion(),
      ),
    );

    expect(generated).not.toContain('/health');
    expect(generated).not.toContain('/ready');
  });
});

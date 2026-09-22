import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CollectionDefinition } from 'postman-collection';
import { Collection } from 'postman-collection';

import { buildPostmanCollection, stripKey } from './build-postman-collection';

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
  it('matches what the generator produces from the committed openapi.json right now — catches "changed a schema, forgot to regenerate"', async () => {
    // `id` / `_postman_id` are stripped before comparing: openapi-to-postmanv2
    // assigns each item and the collection itself a fresh random UUID on
    // every run (harmless — Postman only needs uniqueness within one
    // document), so they can never match bit-for-bit across two independent
    // generations.
    const normalize = (value: unknown): unknown =>
      stripKey(stripKey(value, 'id'), '_postman_id');
    const committed = normalize(committedCollection());
    const fresh = normalize(
      JSON.parse(
        JSON.stringify(
          await buildPostmanCollection(
            committedOpenApiDocument(),
            packageVersion(),
          ),
        ),
      ),
    );

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
});

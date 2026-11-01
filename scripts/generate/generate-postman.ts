import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildPostmanCollection,
  preservePostmanIds,
} from '@/postman/build-postman-collection';

const openApiDocument = JSON.parse(
  readFileSync(join(__dirname, '../../openapi/v1.json'), 'utf8'),
) as unknown;
const collectionPath = join(__dirname, '../../aihub.postman_collection.json');

// The collection is built from the /v1 contract: its scenarios are /v1 requests.
// /v2 requests are not in it yet.
function openApiVersion(document: unknown): string {
  const info = (document as { info?: { version?: unknown } }).info;
  if (typeof info?.version !== 'string') {
    throw new Error('openapi/v1.json has no info.version');
  }
  return info.version;
}

async function main(): Promise<void> {
  const generated = await buildPostmanCollection(
    openApiDocument,
    openApiVersion(openApiDocument),
  );
  const collection = existsSync(collectionPath)
    ? preservePostmanIds(
        generated,
        JSON.parse(readFileSync(collectionPath, 'utf8')) as unknown,
      )
    : generated;

  // Trailing newline so the committed file diffs cleanly.
  writeFileSync(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);

  console.log('Wrote aihub.postman_collection.json');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

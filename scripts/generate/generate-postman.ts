import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildPostmanCollection,
  preservePostmanIds,
} from '@/postman/build-postman-collection';

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8'),
) as { version: string };
const openApiDocument = JSON.parse(
  readFileSync(join(__dirname, '../../openapi.json'), 'utf8'),
) as unknown;
const collectionPath = join(__dirname, '../../aihub.postman_collection.json');

async function main(): Promise<void> {
  const generated = await buildPostmanCollection(
    openApiDocument,
    packageJson.version,
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

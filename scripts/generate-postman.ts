import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildPostmanCollection } from '../src/postman/build-postman-collection';

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8'),
) as { version: string };
const openApiDocument = JSON.parse(
  readFileSync(join(__dirname, '../openapi.json'), 'utf8'),
) as unknown;

buildPostmanCollection(openApiDocument, packageJson.version)
  .then((collection) => {
    // Trailing newline so the committed file diffs cleanly.
    writeFileSync(
      'aihub.postman_collection.json',
      `${JSON.stringify(collection, null, 2)}\n`,
    );
    console.log('Wrote aihub.postman_collection.json');
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });

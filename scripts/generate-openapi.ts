import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOpenApiDocument } from '@/openapi/build-openapi-document';

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8'),
) as { version: string };

const document = buildOpenApiDocument(packageJson.version);

// Trailing newline so the committed file diffs cleanly and matches how most
// editors/linters expect a text file to end.
writeFileSync('openapi.json', `${JSON.stringify(document, null, 2)}\n`);

console.log('Wrote openapi.json');

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOpenApiDocument } from '@/openapi/build-openapi-document';
import {
  PUBLIC_API_CONTRACT_VERSION,
  PUBLIC_API_MAJOR_PATH,
} from '@/openapi/public-api-contract-version';

const document = buildOpenApiDocument(PUBLIC_API_CONTRACT_VERSION);
const serialized = `${JSON.stringify(document, null, 2)}\n`;
const versionedDirectory = join(__dirname, '../../openapi');
const versionedPath = join(versionedDirectory, `${PUBLIC_API_MAJOR_PATH}.json`);

mkdirSync(versionedDirectory, { recursive: true });
writeFileSync(versionedPath, serialized);
writeFileSync('openapi.json', serialized);

console.log(`Wrote openapi.json and ${versionedPath}`);

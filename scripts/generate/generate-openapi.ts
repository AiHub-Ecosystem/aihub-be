import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PUBLIC_API_MAJORS,
  latestPublicApiMajor,
  supportedPublicApiMajors,
} from '@/catalog/public-api-majors';
import { buildOpenApiDocument } from '@/openapi/build-openapi-document';

const VERSIONED_SPEC = /^v[1-9][0-9]*\.json$/u;
const versionedDirectory = join(__dirname, '../../openapi');

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

mkdirSync(versionedDirectory, { recursive: true });

// A retired major's contract leaves with the release that retires it.
const supportedFiles = new Set(
  supportedPublicApiMajors().map(({ major }) => `v${major}.json`),
);
for (const name of readdirSync(versionedDirectory)) {
  if (VERSIONED_SPEC.test(name) && !supportedFiles.has(name)) {
    rmSync(join(versionedDirectory, name));
  }
}

for (const major of supportedPublicApiMajors()) {
  writeFileSync(
    join(versionedDirectory, `v${major.major}.json`),
    serialize(buildOpenApiDocument(major)),
  );
}
writeFileSync(
  'openapi.json',
  serialize(buildOpenApiDocument(latestPublicApiMajor())),
);
// The release gate reads the lifecycle from here; it cannot import TypeScript.
writeFileSync(
  join(versionedDirectory, 'majors.json'),
  serialize(PUBLIC_API_MAJORS),
);

console.log(`Wrote openapi.json and ${versionedDirectory}`);

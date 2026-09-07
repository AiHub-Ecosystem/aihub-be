import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOpenApiDocument } from './build-openapi-document';

const REPO_ROOT = join(__dirname, '../..');
const SPEC_PATH = join(REPO_ROOT, 'openapi.json');

function committedDocument(): unknown {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
}

function packageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { version: string };
  return packageJson.version;
}

describe('committed openapi.json', () => {
  it('matches what the generator produces right now — catches "changed a schema, forgot to regenerate"', () => {
    const committed = committedDocument();
    const fresh = JSON.parse(
      JSON.stringify(buildOpenApiDocument(packageVersion())),
    );

    expect(committed).toEqual(fresh);
  });

  // OpenAPI 3.1 validity itself is checked by `scripts/validate-openapi.mjs`
  // (wired into `pnpm verify`), not here: the validator package is ESM-only
  // and Jest's CommonJS transform pipeline cannot load it, even via a
  // dynamic import — the failure surfaces one module down, inside the
  // package's own `import` statements, which Jest still has to parse.
});

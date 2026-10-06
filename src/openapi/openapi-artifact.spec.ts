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

  it('publishes the owner-only identity configuration read and both data shapes', () => {
    const document = committedDocument() as {
      paths: Record<string, unknown>;
    };
    const path = document.paths[
      '/v1/organizations/{organization_id}/identity-config'
    ] as {
      get?: {
        operationId?: string;
        description?: string;
        security?: unknown[];
        responses?: Record<string, unknown>;
      };
    };

    expect(path.get).toMatchObject({
      operationId: 'organizations.identityConfig.read',
      description: expect.stringContaining('active owner'),
      security: [{ BearerAuth: [] }],
    });

    const successResponse = JSON.stringify(path.get?.responses?.['200']);
    expect(successResponse).toContain('"const":true');
    expect(successResponse).toContain('"const":false');
  });

  it('publishes the owner identity configuration PUT and safe retry errors', () => {
    const document = committedDocument() as {
      paths: Record<string, unknown>;
      components: { responses: Record<string, unknown> };
    };
    const path = document.paths[
      '/v1/organizations/{organization_id}/identity-config'
    ] as {
      put?: {
        operationId?: string;
        security?: unknown[];
        requestBody?: unknown;
        responses?: Record<string, unknown>;
      };
    };

    expect(path.put).toMatchObject({
      operationId: 'organizations.identityConfig.set',
      security: [{ BearerAuth: [] }],
    });
    expect(JSON.stringify(path.put?.requestBody)).toContain('jwks_url');
    expect(path.put?.responses?.['409']).toBeDefined();
    expect(path.put?.responses?.['503']).toBeDefined();
    expect(JSON.stringify(document.components.responses.Error400)).toContain(
      'IDENTITY_JWKS_URL_UNSAFE',
    );
    expect(JSON.stringify(document.components.responses.Error400)).toContain(
      'IDENTITY_JWKS_INVALID',
    );
    expect(JSON.stringify(document.components.responses.Error503)).toContain(
      'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
    );
  });

  it('publishes the roster saved-state boolean without identity configuration material', () => {
    const document = committedDocument() as {
      paths: Record<string, unknown>;
    };
    const path = document.paths['/v1/organizations/me/members'] as {
      get?: { description?: string; responses?: Record<string, unknown> };
    };
    const success = JSON.stringify(path.get?.responses?.['200']);

    expect(path.get?.description).toContain('JWKS source is not probed');
    expect(success).toContain('identity_configured');
    expect(success).not.toContain('jwks_url');
    expect(success).not.toContain('public_keys_jwks');
  });

  it('keeps infrastructure health endpoints out of the public API document', () => {
    const document = committedDocument() as {
      paths: Record<string, unknown>;
    };

    expect(document.paths).not.toHaveProperty('/health');
    expect(document.paths).not.toHaveProperty('/ready');
  });

  // OpenAPI 3.1 validity itself is checked by `scripts/validate-openapi.mjs`
  // (wired into `pnpm verify`), not here: the validator package is ESM-only
  // and Jest's CommonJS transform pipeline cannot load it, even via a
  // dynamic import — the failure surfaces one module down, inside the
  // package's own `import` statements, which Jest still has to parse.
});

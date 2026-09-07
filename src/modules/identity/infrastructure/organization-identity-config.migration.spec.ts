import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('organization identity configuration migration', () => {
  it('keeps the control-plane constraints required by the identity contract', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../database/migrations/0003_organization_identity_configs.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS organization_identity_configs',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION is_public_identity_jwks',
    );
    expect(migration).toContain(
      'organization_id           text PRIMARY KEY REFERENCES organizations(id)',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS oic_issuer_uq',
    );
    expect(migration).toContain(
      'CHECK (jwks_url IS NOT NULL OR public_keys_jwks IS NOT NULL)',
    );
    expect(migration).toContain("CHECK (status IN ('active', 'disabled'))");
    expect(migration).toContain('CHECK (max_assertion_ttl_seconds > 0');
    expect(migration).toContain("ARRAY['RS256', 'ES256']");
  });
});

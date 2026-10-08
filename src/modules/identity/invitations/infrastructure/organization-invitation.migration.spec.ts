import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('organization invitation migration', () => {
  it('keeps the durable invitation constraints required by the identity contract', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0010_organization_invitations.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS organization_invitations',
    );
    expect(migration).toContain(
      "id                 text PRIMARY KEY CHECK (id ~ '^oiv_[0-9A-HJKMNP-TV-Z]{26}$')",
    );
    expect(migration).toContain(
      'organization_id    text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT',
    );
    expect(migration).toContain(
      'invited_by         text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT',
    );
    expect(migration).toContain('CHECK (char_length(email) BETWEEN 3 AND 320)');
    expect(migration).toContain("CHECK (role IN ('owner', 'admin', 'member'))");
    expect(migration).toContain(
      "token_hash         text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$')",
    );
    expect(migration).toContain('CHECK (expires_at > created_at)');
    // The partial index is what makes "one open invitation per organization and
    // normalized email" durable rather than an application-only convention.
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_one_open',
    );
    expect(migration).toContain(
      'ON organization_invitations (organization_id, email)',
    );
    expect(migration).toContain('WHERE consumed_at IS NULL');
  });

  it('does not change the durable membership shape', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0010_organization_invitations.sql',
      ),
      'utf8',
    );

    expect(migration).not.toContain('organization_members');
    expect(migration).not.toContain("'pending'");
  });
});

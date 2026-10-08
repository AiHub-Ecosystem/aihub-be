import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('organization membership migration', () => {
  it('keeps the durable membership constraints required by the identity contract', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0009_organization_members.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS organization_members',
    );
    expect(migration).toContain(
      'PRIMARY KEY (organization_id, user_account_id)',
    );
    expect(migration).toContain(
      'organization_id      text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT',
    );
    expect(migration).toContain(
      'user_account_id      text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT',
    );
    expect(migration).toContain("CHECK (role IN ('owner', 'admin', 'member'))");
    expect(migration).toContain("CHECK (status IN ('active', 'disabled'))");
    expect(migration).toContain('created_at           timestamptz NOT NULL');
    expect(migration).toContain('updated_at           timestamptz NOT NULL');
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS organization_members_user_account_idx',
    );
    expect(migration).toContain(
      'CREATE TRIGGER organization_members_set_updated_at',
    );
  });
});

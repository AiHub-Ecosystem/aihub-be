import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = join(
  __dirname,
  '../../../../../prisma/migrations/0042_email_delivery_invitation_fair_share/migration.sql',
);
const VALIDATION_MIGRATION = join(
  __dirname,
  '../../../../../prisma/migrations/0043_validate_email_delivery_invitation_fair_share/migration.sql',
);

describe('email delivery invitation fair-share migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('adds nullable Organization and inviter scheduling IDs for legacy rows', () => {
    expect(sql).toContain('ADD COLUMN organization_id text');
    expect(sql).toContain('ADD COLUMN inviter_id text');
    expect(sql).not.toMatch(
      /ADD COLUMN\s+(organization_id|inviter_id)\s+text\s+NOT NULL/i,
    );
  });

  it('allows IDs only together on invitation rows', () => {
    expect(sql).toMatch(/kind = 'organization_invite_email'/);
    expect(sql).toMatch(/organization_id IS NOT NULL/);
    expect(sql).toMatch(/inviter_id IS NOT NULL/);
  });

  it('validates the check in a later migration transaction', () => {
    expect(readFileSync(VALIDATION_MIGRATION, 'utf8')).toContain(
      'VALIDATE CONSTRAINT email_delivery_requests_invitation_fair_share_ids_check',
    );
  });
});

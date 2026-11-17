import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('user avatar audits migration (#429)', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../../prisma/migrations/0067_user_avatar_audits/migration.sql',
    ),
    'utf8',
  );

  it('records one account-scoped event per accepted Avatar change', () => {
    expect(sql).toContain('CREATE TABLE user_avatar_audits');
    expect(sql).toContain("id ~ '^uaa_[0-9A-HJKMNP-TV-Z]{26}$'");
    expect(sql).toContain('REFERENCES user_accounts(id) ON DELETE RESTRICT');
    expect(sql).toContain(
      "action IN ('avatar.set', 'avatar.replaced', 'avatar.removed')",
    );
    expect(sql).toContain("asset_id ~ '^ava_[0-9A-HJKMNP-TV-Z]{26}$'");
  });

  it('keeps the trail append-only', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON user_avatar_audits');
    expect(sql).toContain(
      "RAISE EXCEPTION 'user_avatar_audits is append-only'",
    );
  });
});

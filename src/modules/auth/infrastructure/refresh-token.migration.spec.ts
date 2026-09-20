import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('refresh token migration', () => {
  it('keeps opaque refresh credentials hash-only with family and account indexes', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../database/migrations/0007_refresh_tokens.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE refresh_tokens');
    expect(sql).toContain("id ~ '^rft_[0-9A-HJKMNP-TV-Z]{26}$'");
    expect(sql).toContain("family_id ~ '^rfs_[0-9A-HJKMNP-TV-Z]{26}$'");
    expect(sql).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('REFERENCES user_accounts(id) ON DELETE RESTRICT');
    expect(sql).toContain('refresh_tokens_family_id');
    expect(sql).toContain('refresh_tokens_user_account_id');
    expect(sql).not.toContain('token_value');
  });
});

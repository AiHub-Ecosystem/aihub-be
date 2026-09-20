import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('password reset token migration', () => {
  it('keeps reset credentials hash-only, single-use, and one-open-per-account', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../database/migrations/0008_password_reset_tokens.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE password_reset_tokens');
    expect(sql).toContain("id ~ '^prt_[0-9A-HJKMNP-TV-Z]{26}$'");
    expect(sql).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('password_reset_one_open_token');
    expect(sql).toContain('password_reset_tokens_user_account_id');
    expect(sql).toContain('REFERENCES user_accounts(id) ON DELETE RESTRICT');
    expect(sql).not.toContain('token_value');
  });
});

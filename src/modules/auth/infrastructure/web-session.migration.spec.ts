import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('web session migration', () => {
  it('keeps opaque web session credentials hash-only with an account index', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../database/migrations/0033_web_sessions.sql'),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE web_sessions');
    expect(sql).toContain("id ~ '^wbs_[0-9A-HJKMNP-TV-Z]{26}$'");
    expect(sql).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toMatch(/token_hash\s+text NOT NULL UNIQUE/);
    expect(sql).toContain('REFERENCES user_accounts(id) ON DELETE RESTRICT');
    expect(sql).toContain('created_at');
    expect(sql).toContain('expires_at');
    expect(sql).toContain('last_renewed_at');
    expect(sql).toContain('revoked_at');
    expect(sql).toContain('web_sessions_user_account_id');
    expect(sql).toContain('CHECK (expires_at > created_at)');
    expect(sql).not.toContain('token_value');
    expect(sql).not.toContain('refresh_tokens');
  });
});

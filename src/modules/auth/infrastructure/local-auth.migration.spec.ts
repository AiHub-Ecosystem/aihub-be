import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('local auth migration', () => {
  it('keeps durable identity, hash-only token, and reservation constraints in Postgres', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../database/migrations/0006_local_auth.sql'),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE user_accounts');
    expect(sql).toContain(
      "status IN ('pending_verification', 'active', 'disabled')",
    );
    expect(sql).toContain('UNIQUE (provider, canonical_email)');
    expect(sql).toContain(
      "password_hash LIKE '$argon2id$v=19$m=65536,t=3,p=1$%'",
    );
    expect(sql).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('email_verification_one_open_token');
  });
});

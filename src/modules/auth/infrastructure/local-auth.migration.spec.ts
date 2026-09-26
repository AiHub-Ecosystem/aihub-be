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

  it('adds nullable Verification Sign-in columns without touching consumption', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../database/migrations/0022_email_verification_sign_in.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('ADD COLUMN browser_binding_hash text');
    expect(sql).toContain("browser_binding_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('ADD COLUMN signed_in_at timestamptz');
    expect(sql).not.toMatch(
      /ADD COLUMN \w+ \w+ NOT NULL|consumed_at\s*=|DROP /,
    );
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ARGON2ID_HASH_CONSTRAINT_PATTERN } from '@/modules/auth/local-credentials/application/argon2id-parameters';

describe('local auth migration', () => {
  it('keeps durable identity, hash-only token, and reservation constraints in Postgres', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../../prisma/migrations/0006_local_auth/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE user_accounts');
    expect(sql).toContain(
      "status IN ('pending_verification', 'active', 'disabled')",
    );
    expect(sql).toContain('UNIQUE (provider, canonical_email)');
    expect(sql).toContain("password_hash LIKE '$argon2id$v=19$");
    expect(sql).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('email_verification_one_open_token');
  });

  it('accepts the owned password hash factor in any order', () => {
    const migrationsDirectory = join(
      __dirname,
      '../../../../../prisma/migrations',
    );
    const constraintMigrations = readdirSync(migrationsDirectory, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(migrationsDirectory, entry.name, 'migration.sql'))
      .filter((path) => {
        const sql = readFileSync(path, 'utf8');
        return (
          sql.includes('auth_identities_password_hash_check') &&
          sql.includes('ADD CONSTRAINT')
        );
      })
      .sort();

    expect(constraintMigrations.length).toBeGreaterThan(0);
    const sql = readFileSync(constraintMigrations.at(-1) as string, 'utf8');

    expect(sql).toContain(
      'DROP CONSTRAINT auth_identities_password_hash_check',
    );
    expect(sql).toContain('ADD CONSTRAINT auth_identities_password_hash_check');
    expect(sql).toContain(ARGON2ID_HASH_CONSTRAINT_PATTERN);
  });

  it('adds nullable Verification Sign-in columns without touching consumption', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../../prisma/migrations/0022_email_verification_sign_in/migration.sql',
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

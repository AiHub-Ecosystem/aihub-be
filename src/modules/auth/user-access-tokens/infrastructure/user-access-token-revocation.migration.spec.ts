import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('User Access JWT revocation migration', () => {
  it('persists only verified token identity and indexes expiry for cleanup', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../../prisma/migrations/0060_user_access_token_revocations/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE user_access_token_revocations');
    expect(sql).toContain('PRIMARY KEY (issuer, jti)');
    expect(sql).toContain('effective_expires_at  timestamptz NOT NULL');
    expect(sql).toContain('user_access_token_revocations_expiry_idx');
    expect(sql).not.toMatch(/raw_token|token_value|compact_jwt/iu);
  });
});

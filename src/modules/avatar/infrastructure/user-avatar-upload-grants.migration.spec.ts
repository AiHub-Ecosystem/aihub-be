import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('upload storage ceilings migration (#374)', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../../prisma/migrations/0062_upload_storage_ceilings/migration.sql',
    ),
    'utf8',
  );

  it('binds every grant to an account and to an Avatar key layout', () => {
    expect(sql).toContain('CREATE TABLE user_avatar_upload_grants');
    expect(sql).toContain(
      'REFERENCES user_accounts(id) ON DELETE CASCADE ON UPDATE NO ACTION',
    );
    expect(sql).toContain(
      "object_key ~ '^users/usr_[0-9A-HJKMNP-TV-Z]{26}/avatar/ava_[0-9A-HJKMNP-TV-Z]{26}/original$'",
    );
  });

  it('counts open and issued grants separately', () => {
    expect(sql).toContain("status IN ('open', 'consumed')");
    // Issuance counts every grant in the window, so it indexes created_at.
    expect(sql).toContain(
      'user_avatar_upload_grants (user_account_id, created_at)',
    );
    // The open-URL ceiling counts unexpired grants.
    expect(sql).toContain('user_avatar_upload_grants (expires_at)');
  });

  it('refuses a grant that expires before it was created', () => {
    expect(sql).toContain('CHECK (expires_at > created_at)');
  });
});

describe('Speaking Audio Organization ceiling indexes (#374)', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../../prisma/migrations/0062_upload_storage_ceilings/migration.sql',
    ),
    'utf8',
  );

  it('makes the per-Organization counts readable without a table scan', () => {
    expect(sql).toContain(
      'speaking_audio_upload_intents (organization_id, created_at)',
    );
    expect(sql).toContain(
      'speaking_audio_upload_intents (organization_id, expires_at)',
    );
    expect(sql).toContain('speaking_audio_assets (organization_id)');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Speaking Audio upload migration', () => {
  it('keeps upload intents and Audio assets organization-scoped and bounded', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../database/migrations/0025_speaking_audio_assets.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE speaking_audio_upload_intents');
    expect(sql).toContain('CREATE TABLE speaking_audio_assets');
    expect(sql).toContain('REFERENCES organizations(id) ON DELETE RESTRICT');
    expect(sql).toContain("environment IN ('production', 'sandbox')");
    expect(sql).toContain('byte_size BETWEEN 100 AND 26214400');
    expect(sql).toContain("status IN ('open', 'rejected')");
    expect(sql).toContain(
      "'orgs/' || organization_id || '/speaking/' || id || '/original'",
    );
    expect(sql).toContain('retention_expires_at');
    expect(sql).not.toContain('redis');
  });
});

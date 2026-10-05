import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = join(
  __dirname,
  '../../../../database/migrations/0028_email_delivery_request_lease.sql',
);

describe('email delivery request lease migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('adds the lease columns a claim writes and a release clears', () => {
    expect(sql).toContain('ADD COLUMN lease_owner');
    expect(sql).toContain('ADD COLUMN lease_expires_at');
  });

  it('keeps both columns nullable so rows queued before it stay claimable', () => {
    expect(sql).not.toMatch(/ADD COLUMN\s+lease_\w+\s+text\s+NOT NULL/i);
  });

  it('bounds the lease owner to an identifier, not free text', () => {
    expect(sql).toMatch(
      /lease_owner IS NULL OR lease_owner ~ '\^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\[a-z0-9\]\$'/,
    );
  });
});

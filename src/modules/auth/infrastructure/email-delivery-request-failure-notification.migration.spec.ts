import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = join(
  __dirname,
  '../../../../database/migrations/0030_email_delivery_request_failure_notification.sql',
);

describe('email delivery request failure notification migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('adds the timestamp a terminal failure records its alert on', () => {
    expect(sql).toContain('ADD COLUMN failure_reported_at');
  });

  it('leaves it nullable, so a request that has not failed has nothing to report', () => {
    expect(sql).not.toMatch(
      /ADD COLUMN\s+failure_reported_at\s+timestamptz\s+NOT NULL/i,
    );
  });

  // The column is read back by the reconciling query, so it must not be
  // recordable on a request that is still queued or still deliverable.
  it('records a notification only on a failed request', () => {
    expect(sql).toMatch(
      /CHECK \(failure_reported_at IS NULL OR status = 'failed'\)/,
    );
  });
});

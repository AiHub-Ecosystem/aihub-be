import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('usage records migration', () => {
  it('creates durable one-row-per-request evidence and billing indexes', async () => {
    const migration = await readFile(
      join(__dirname, '../../../../database/migrations/0005_usage_records.sql'),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS usage_records');
    expect(migration).toContain('request_id        text PRIMARY KEY');
    expect(migration).toMatch(/outcome IN[\s\S]*'internal_error'/);
    expect(migration).toMatch(/metering_status IN[\s\S]*'quota_unverified'/);
    expect(migration).toContain('billable_requests IN (0, 1)');
    expect(migration).toContain('usage_org_time_idx');
    expect(migration).toContain('usage_created_brin');
  });
});

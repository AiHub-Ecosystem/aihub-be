import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Speaking grading jobs migration', () => {
  it('stores durable jobs with bounded status, concurrency and sweep indexes', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../../prisma/migrations/0063_speaking_grading_jobs/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE TABLE speaking_grading_jobs');
    expect(sql).toContain(
      'max_concurrent         integer NOT NULL CHECK (max_concurrent > 0)',
    );
    expect(sql).toContain(
      "status IN ('queued', 'running', 'succeeded', 'failed')",
    );
    expect(sql).toContain('result                 jsonb');
    expect(sql).toContain('quota_tracked          boolean NOT NULL');
    expect(sql).toContain('quota_unverified       boolean NOT NULL');
    expect(sql).toContain('speaking_grading_jobs_claim_idx');
    expect(sql).toContain('speaking_grading_jobs_status_created_idx');
    expect(sql).toContain('speaking_grading_jobs_lease_idx');
    expect(sql).toContain('speaking_grading_jobs_dispatch_idx');
    expect(sql).toContain('speaking_grading_jobs_org_in_flight_idx');
    expect(sql).toContain('speaking_grading_jobs_retention_idx');
    expect(sql).not.toContain('redis');
  });
});

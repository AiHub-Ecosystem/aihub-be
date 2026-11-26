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
    expect(sql).toContain('quota_reservation_active boolean NOT NULL');
    expect(sql).toContain('quota_reservation_active boolean NOT NULL');
    expect(sql).toContain('speaking_grading_jobs_claim_idx');
    expect(sql).toContain('speaking_grading_jobs_status_created_idx');
    expect(sql).toContain('speaking_grading_jobs_lease_idx');
    expect(sql).toContain('speaking_grading_jobs_dispatch_idx');
    expect(sql).toContain('speaking_grading_jobs_org_in_flight_idx');
    expect(sql).toContain('speaking_grading_jobs_retention_idx');
    expect(sql).toContain('speaking_grading_jobs_org_user_key_idx');
    expect(sql).toContain('idempotency_key        text');
    expect(sql).not.toContain('redis');
  });

  it('indexes jobs by Organization and End-User ID for erasure', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../../prisma/migrations/0071_speaking_grading_jobs_end_user_idx/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS speaking_grading_jobs_org_end_user_idx',
    );
    expect(sql).toContain(
      'ON speaking_grading_jobs (organization_id, end_user_id)',
    );
  });
});

CREATE INDEX CONCURRENTLY IF NOT EXISTS speaking_grading_jobs_org_end_user_idx
  ON speaking_grading_jobs (organization_id, end_user_id);

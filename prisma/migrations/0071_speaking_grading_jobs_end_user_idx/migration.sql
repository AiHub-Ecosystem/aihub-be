-- The migration runner wraps each file in a transaction. The 30-day job
-- retention and transactional build are accepted for this erasure index while
-- non-transactional migration support remains tracked in #283.
CREATE INDEX IF NOT EXISTS speaking_grading_jobs_org_end_user_idx -- squawk-ignore require-concurrent-index-creation -- transactional runner exception accepted for end-user erasure; approved: #1967
  ON speaking_grading_jobs (organization_id, end_user_id);

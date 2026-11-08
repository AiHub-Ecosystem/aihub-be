CREATE TABLE speaking_grading_jobs (
  job_id                 text PRIMARY KEY
                         CHECK (job_id ~ '^sgj_[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id        text NOT NULL,
  end_user_id            text NOT NULL,
  environment            text NOT NULL
                         CHECK (environment IN ('production', 'sandbox')),
  api_key_id             text NOT NULL,
  max_concurrent         integer NOT NULL CHECK (max_concurrent > 0), -- squawk-ignore prefer-bigint-over-int -- mirrors organizations.max_concurrent, an integer; approved: #1718
  quota_tracked          boolean NOT NULL,
  audio_asset_id         text NOT NULL,
  part                   integer NOT NULL CHECK (part BETWEEN 1 AND 3), -- squawk-ignore prefer-bigint-over-int -- an IELTS Speaking part number, 1..3; approved: #1718
  question_id            text NOT NULL,
  prompt_text            text,
  test_type              text,
  test_code              text,
  part_result_id         text,
  status                 text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  lease_expires_at       timestamptz,
  dispatch_started_at    timestamptz,
  result                 jsonb,
  error_code             text,
  error_message          text,
  error_retryable        boolean,
  created_at             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at           timestamptz
);

CREATE INDEX speaking_grading_jobs_claim_idx
  ON speaking_grading_jobs (job_id, status);

CREATE INDEX speaking_grading_jobs_status_created_idx
  ON speaking_grading_jobs (status, created_at);

CREATE INDEX speaking_grading_jobs_lease_idx
  ON speaking_grading_jobs (status, lease_expires_at);

CREATE INDEX speaking_grading_jobs_dispatch_idx
  ON speaking_grading_jobs (status, dispatch_started_at);

CREATE INDEX speaking_grading_jobs_org_in_flight_idx
  ON speaking_grading_jobs (organization_id, environment, status, created_at);

CREATE INDEX speaking_grading_jobs_retention_idx
  ON speaking_grading_jobs (created_at);

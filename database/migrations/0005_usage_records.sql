CREATE TABLE IF NOT EXISTS usage_records (
  request_id        text PRIMARY KEY,
  organization_id   text NOT NULL,
  api_key_id        text NOT NULL,
  actor_id          text,
  service           text NOT NULL,
  operation         text NOT NULL,
  environment       text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN
                    ('success','client_error','downstream_error','internal_error')),
  http_status       integer NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  error_code        text,
  billable_requests integer NOT NULL DEFAULT 0
                    CHECK (billable_requests IN (0, 1)),
  input_tokens      integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens     integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens      integer CHECK (total_tokens IS NULL OR total_tokens >= 0),
  models            jsonb, -- nullable compatibility field; current AI Services omit model identity
  metering_status   text NOT NULL CHECK (metering_status IN
                    ('complete','missing_usage','not_applicable','quota_unverified')),
  total_ms          integer NOT NULL CHECK (total_ms >= 0),
  downstream_ms     integer CHECK (downstream_ms IS NULL OR downstream_ms >= 0),
  ai_processing_ms  integer CHECK (ai_processing_ms IS NULL OR ai_processing_ms >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_org_time_idx
  ON usage_records (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS usage_created_brin
  ON usage_records USING BRIN (created_at);

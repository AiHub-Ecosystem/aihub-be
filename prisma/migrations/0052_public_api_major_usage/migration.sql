-- One row per UTC day, Environment, Public API major, and Organization (ADR-0127).
-- An empty organization_id counts requests that carried no authenticated
-- Organization. Counts only: no key, request, or user data.
CREATE TABLE IF NOT EXISTS public_api_major_usage (
  usage_day       date        NOT NULL,
  environment     text        NOT NULL,
  major           integer     NOT NULL, -- squawk-ignore prefer-bigint-over-int -- a Public API major number, one per released contract; approved: #1366
  organization_id text        NOT NULL DEFAULT '',
  request_count   bigint      NOT NULL DEFAULT 0,
  failure_count   bigint      NOT NULL DEFAULT 0,
  last_seen_at    timestamptz NOT NULL,
  PRIMARY KEY (usage_day, environment, major, organization_id),
  CONSTRAINT public_api_major_usage_environment_check
    CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT public_api_major_usage_major_check CHECK (major >= 1),
  CONSTRAINT public_api_major_usage_counts_check
    CHECK (request_count >= 0 AND failure_count >= 0 AND failure_count <= request_count)
);

-- Evidence that Public API major counts are complete (ADR-0127, #1376, #1389).
-- Both tables are new so public_api_major_usage keeps its key: the release
-- being replaced keeps writing it unchanged during a blue-green deploy.

-- One row per running process: every request it served between started_at and
-- covered_through is counted. A failed write keeps its counts for the next one,
-- so only a process's death can lose counts; stopped_cleanly_at stays NULL then.
CREATE TABLE IF NOT EXISTS public_api_major_usage_coverage (
  process_id         uuid        PRIMARY KEY,
  environment        text        NOT NULL,
  started_at         timestamptz NOT NULL,
  covered_through    timestamptz NOT NULL,
  stopped_cleanly_at timestamptz,
  CONSTRAINT public_api_major_usage_coverage_environment_check
    CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT public_api_major_usage_coverage_order_check
    CHECK (covered_through >= started_at)
);

-- Unattributed requests by how the route authenticates its caller. The kind is
-- checked by shape, not against a list, so a newer release can write a kind
-- this one has not been taught (ADR-0128).
CREATE TABLE IF NOT EXISTS public_api_major_unattributed_usage (
  usage_day     date    NOT NULL,
  environment   text    NOT NULL,
  major         integer NOT NULL, -- squawk-ignore prefer-bigint-over-int -- a Public API major number, matching public_api_major_usage.major; approved: #1389
  caller_kind   text    NOT NULL,
  request_count bigint  NOT NULL DEFAULT 0,
  failure_count bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (usage_day, environment, major, caller_kind),
  CONSTRAINT public_api_major_unattributed_usage_environment_check
    CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT public_api_major_unattributed_usage_major_check CHECK (major >= 1),
  CONSTRAINT public_api_major_unattributed_usage_caller_kind_check
    CHECK (caller_kind ~ '^[a-z][a-z-]{0,39}$'),
  CONSTRAINT public_api_major_unattributed_usage_counts_check
    CHECK (request_count >= 0 AND failure_count >= 0 AND failure_count <= request_count)
);

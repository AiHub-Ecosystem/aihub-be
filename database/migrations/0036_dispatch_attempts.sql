CREATE TABLE IF NOT EXISTS dispatch_attempts (
  attempt_id uuid PRIMARY KEY,
  request_id text NOT NULL,
  organization_id text NOT NULL,
  operation text NOT NULL,
  created_at timestamptz NOT NULL,
  unknown_after timestamptz NOT NULL,
  outcome text CHECK (outcome IN (
    'response_received',
    'not_dispatched',
    'outcome_unknown'
  )),
  CHECK (unknown_after > created_at)
);

CREATE INDEX IF NOT EXISTS dispatch_attempts_unresolved_idx
  ON dispatch_attempts (unknown_after, operation)
  WHERE outcome IS NULL OR outcome = 'outcome_unknown';

CREATE INDEX IF NOT EXISTS dispatch_attempts_retention_idx
  ON dispatch_attempts (created_at, attempt_id);

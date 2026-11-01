-- Which Speaking results a caller has used (ADR-0138 decision 4). Tenant rows:
-- the row-level-security policy follows the ADR-0109 phased rollout with the
-- other Organization tables.
CREATE TABLE speaking_v2_result_ownership (
  organization_id text NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  end_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('response', 'part', 'test')),
  id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, environment, end_user_id, kind, id)
);

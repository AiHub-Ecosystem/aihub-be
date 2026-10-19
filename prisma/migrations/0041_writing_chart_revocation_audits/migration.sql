CREATE TABLE writing_chart_revocation_audits (
  id text PRIMARY KEY
    CHECK (id ~ '^wra_[0-9A-HJKMNP-TV-Z]{26}$'),
  asset_id text NOT NULL
    CHECK (asset_id ~ '^chart_[0-9A-HJKMNP-TV-Z]{26}$'),
  actor_user_account_id text NOT NULL
    REFERENCES user_accounts(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  occurred_at timestamptz(6) NOT NULL,
  phase text NOT NULL
    CHECK (phase IN ('requested', 'completed')),
  origin_outcome text
    CHECK (origin_outcome IS NULL OR origin_outcome IN ('deleted', 'already_absent', 'failed')),
  edge_outcome text
    CHECK (edge_outcome IS NULL OR edge_outcome IN ('serving', 'not_serving', 'redirect', 'unavailable')),
  edge_status integer -- squawk-ignore prefer-bigint-over-int -- HTTP status is bounded by 100..599; approved: #816
    CHECK (edge_status IS NULL OR edge_status BETWEEN 100 AND 599),
  CHECK (
    (phase = 'requested' AND origin_outcome IS NULL AND edge_outcome IS NULL AND edge_status IS NULL)
    OR
    (phase = 'completed' AND origin_outcome IS NOT NULL AND edge_outcome IS NOT NULL)
  )
);

CREATE INDEX writing_chart_revocation_audits_retention_idx
  ON writing_chart_revocation_audits (occurred_at, id);

CREATE INDEX writing_chart_revocation_audits_actor_user_account_id_idx
  ON writing_chart_revocation_audits (actor_user_account_id);

CREATE FUNCTION writing_chart_revocation_audits_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'writing_chart_revocation_audits is append-only';
  END IF;

  IF OLD.occurred_at >= statement_timestamp() - INTERVAL '24 months' THEN
    RAISE EXCEPTION 'writing_chart_revocation_audits is inside its retention period';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER writing_chart_revocation_audits_append_only
  BEFORE UPDATE OR DELETE ON writing_chart_revocation_audits
  FOR EACH ROW
  EXECUTE FUNCTION writing_chart_revocation_audits_append_only();

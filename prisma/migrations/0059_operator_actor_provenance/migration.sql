ALTER TABLE organization_audit_events
  ADD COLUMN actor_source text NOT NULL DEFAULT 'legacy_unknown'
  CHECK (actor_source IN ('authenticated_user', 'self_declared_operator', 'legacy_unknown'));

ALTER TABLE writing_chart_revocation_audits
  ADD COLUMN actor_source text NOT NULL DEFAULT 'legacy_unknown'
  CHECK (actor_source IN ('authenticated_user', 'self_declared_operator', 'legacy_unknown'));

ALTER TABLE billing_adjustments
  ADD COLUMN actor_source text NOT NULL DEFAULT 'legacy_unknown'
  CHECK (actor_source IN ('authenticated_user', 'self_declared_operator', 'legacy_unknown'));

ALTER TABLE billing_month_closures
  ADD COLUMN actor_source text NOT NULL DEFAULT 'legacy_unknown'
  CHECK (actor_source IN ('authenticated_user', 'self_declared_operator', 'legacy_unknown'));

CREATE OR REPLACE FUNCTION organization_audit_events_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_audit_events is append-only';
  END IF;

  IF NEW.target_label IS NOT NULL THEN
    RAISE EXCEPTION 'organization_audit_events allows only target_label redaction';
  END IF;

  IF OLD.action = 'organization.renamed' AND OLD.detail ? 'previousName' THEN
    IF NEW.detail IS DISTINCT FROM OLD.detail - 'previousName' THEN
      RAISE EXCEPTION 'organization_audit_events rename redaction must remove previousName';
    END IF;
  ELSIF NEW.detail IS DISTINCT FROM OLD.detail THEN
    RAISE EXCEPTION 'organization_audit_events allows only target_label redaction';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.actor_user_account_id IS DISTINCT FROM OLD.actor_user_account_id
     OR NEW.actor_source IS DISTINCT FROM OLD.actor_source
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
  THEN
    RAISE EXCEPTION 'organization_audit_events allows only target_label redaction';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

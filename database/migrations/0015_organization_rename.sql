-- Organization rename. ADR-0043 records the boundary.

-- Both lists are restated in full, as migrations 0012 and 0014 did, so two
-- slices cannot collide.
ALTER TABLE organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_action_check;

ALTER TABLE organization_audit_events
  ADD CONSTRAINT organization_audit_events_action_check CHECK (action IN (
    'organization.created',
    'organization.renamed',
    'invitation.sent',
    'invitation.resent',
    'invitation.accepted',
    'invitation.revoked',
    'membership.role_changed',
    'membership.disabled',
    'membership.owner_transferred',
    'api_key.created',
    'api_key.rotated',
    'api_key.revoked'));

-- A rename keeps the name it replaced in `detail`, and a name can be personal
-- data, so Audit redaction must reach it too. The one widening: on a rename,
-- redaction removes the label and the `previousName` key together, and it may
-- not remove one without the other. No value is ever rewritten, and no other
-- action's detail becomes writable.
CREATE OR REPLACE FUNCTION organization_audit_events_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_audit_events is append-only';
  END IF;

  -- Redaction removes a label; it does not rewrite one.
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

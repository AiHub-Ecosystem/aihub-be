-- Durable, append-only evidence for organization control-plane mutations.
-- ADR-0035 records the boundary; ADR-0027 deferred it to here.
--
-- One table covers membership, invitations, and API keys because all three
-- answer the same question — what happened inside this Organization — and
-- across three tables that question is a union rather than a query.
CREATE TABLE IF NOT EXISTS organization_audit_events (
  id                    text PRIMARY KEY
                        CHECK (id ~ '^oae_[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id       text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  action                text NOT NULL CHECK (action IN (
                          'invitation.sent',
                          'invitation.resent',
                          'invitation.accepted',
                          'membership.role_changed',
                          'membership.disabled',
                          'membership.owner_transferred',
                          'api_key.created',
                          'api_key.rotated',
                          'api_key.revoked')),
  outcome               text NOT NULL CHECK (outcome IN ('applied', 'denied')),
  -- Polymorphic on purpose: a foreign key would give the record a veto over
  -- the lifecycle of what it records. `target_type` carries the meaning.
  target_type           text NOT NULL
                        CHECK (target_type IN ('membership', 'invitation', 'api_key')),
  target_id             text NOT NULL,
  -- The identifier as it read at that moment, denormalized so the trail never
  -- narrates the past using present-day names. Nulled by Audit redaction.
  target_label          text,
  detail                jsonb,
  request_id            text NOT NULL,
  -- Supplied by the application, never by the database clock, so every event
  -- written in one transaction shares one instant.
  occurred_at           timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS organization_audit_events_org_time_idx
  ON organization_audit_events (organization_id, occurred_at DESC);

-- Append-only enforced here rather than by a dedicated database role: this
-- repository defines no roles or grants at all, and standing one up to protect
-- a single table opens an operational surface out of proportion to the gain.
--
-- The one permitted modification is Audit redaction, which nulls the target
-- label to satisfy an erasure request and leaves the event standing.
CREATE OR REPLACE FUNCTION organization_audit_events_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_audit_events is append-only';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.actor_user_account_id IS DISTINCT FROM OLD.actor_user_account_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.detail IS DISTINCT FROM OLD.detail
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
  THEN
    RAISE EXCEPTION 'organization_audit_events allows only target_label redaction';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_audit_events_append_only
  ON organization_audit_events;

CREATE TRIGGER organization_audit_events_append_only
  BEFORE UPDATE OR DELETE ON organization_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION organization_audit_events_append_only();

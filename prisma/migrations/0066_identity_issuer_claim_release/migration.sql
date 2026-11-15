-- Keep an identity configuration after its issuer claim is released. The
-- operator can free a squatted issuer without deleting durable policy.
ALTER TABLE organization_identity_configs
  ADD COLUMN issuer_claimed boolean NOT NULL DEFAULT true;

-- Plain builds: the migration runner wraps each migration in a transaction.
-- The table stores one row per Organization and is small. Approved: #445.
-- squawk-ignore require-concurrent-index-deletion -- in-transaction cutover; approved: #445
DROP INDEX oic_issuer_uq;
-- squawk-ignore require-concurrent-index-creation -- in-transaction cutover; approved: #445
CREATE UNIQUE INDEX oic_issuer_uq
  ON organization_identity_configs (issuer)
  WHERE issuer_claimed;

-- An N-1 writer knows nothing about issuer_claimed. Any configuration change
-- it makes restores the claim; the release mutation changes only status/claim.
CREATE OR REPLACE FUNCTION organization_identity_configs_restore_issuer_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.issuer,
    NEW.jwks_url,
    NEW.public_keys_jwks,
    NEW.allowed_algorithms,
    NEW.max_assertion_ttl_seconds
  ) IS DISTINCT FROM (
    OLD.issuer,
    OLD.jwks_url,
    OLD.public_keys_jwks,
    OLD.allowed_algorithms,
    OLD.max_assertion_ttl_seconds
  ) OR NEW.status = 'active' THEN
    NEW.issuer_claimed := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_identity_configs_restore_issuer_claim
  ON organization_identity_configs;
CREATE TRIGGER organization_identity_configs_restore_issuer_claim
  BEFORE UPDATE ON organization_identity_configs
  FOR EACH ROW
  EXECUTE FUNCTION organization_identity_configs_restore_issuer_claim();

CREATE OR REPLACE FUNCTION organization_identity_configs_bump_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.issuer,
    NEW.jwks_url,
    NEW.public_keys_jwks,
    NEW.allowed_algorithms,
    NEW.max_assertion_ttl_seconds,
    NEW.status,
    NEW.issuer_claimed
  ) IS DISTINCT FROM (
    OLD.issuer,
    OLD.jwks_url,
    OLD.public_keys_jwks,
    OLD.allowed_algorithms,
    OLD.max_assertion_ttl_seconds,
    OLD.status,
    OLD.issuer_claimed
  ) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_action_check; -- squawk-ignore ban-drop-constraint -- existing check permits a strict subset of the widened values below, replaced in the same transaction; approved: #445

ALTER TABLE organization_audit_events
  ADD CONSTRAINT organization_audit_events_action_check CHECK (action IN (
    'organization.created', 'organization.renamed',
    'organization.suspended', 'organization.restored',
    'organization.identity_config_set', 'organization.identity_issuer_released',
    'organization.entitlement_granted', 'invitation.sent', 'invitation.resent',
    'invitation.accepted', 'invitation.revoked', 'membership.role_changed',
    'membership.disabled', 'membership.owner_transferred',
    'membership.owner_attached', 'api_key.created', 'api_key.rotated',
    'api_key.revoked'
  )) NOT VALID;

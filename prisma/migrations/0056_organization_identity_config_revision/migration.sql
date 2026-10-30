-- A revision that rises each time an Organization's identity configuration
-- changes, so a write can name the state it was based on (ADR-0132, #579).
-- A trigger keeps it right for every writer, the operator CLI included, which
-- writes the table with its own SQL. A save that changes nothing keeps it.
ALTER TABLE organization_identity_configs
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1
  CHECK (revision > 0);

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
    NEW.status
  ) IS DISTINCT FROM (
    OLD.issuer,
    OLD.jwks_url,
    OLD.public_keys_jwks,
    OLD.allowed_algorithms,
    OLD.max_assertion_ttl_seconds,
    OLD.status
  ) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_identity_configs_bump_revision
  ON organization_identity_configs;

CREATE TRIGGER organization_identity_configs_bump_revision
  BEFORE UPDATE ON organization_identity_configs
  FOR EACH ROW
  EXECUTE FUNCTION organization_identity_configs_bump_revision();

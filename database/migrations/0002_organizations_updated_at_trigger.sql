-- organizations.updated_at had a DEFAULT now() at insert time but nothing
-- ever set it again, so it silently went stale on the first entitlement or
-- quota change. A trigger is the only way to guarantee it without relying on
-- every future caller remembering to set it by hand.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organizations_set_updated_at ON organizations;

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

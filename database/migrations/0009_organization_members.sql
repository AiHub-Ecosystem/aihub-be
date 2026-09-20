CREATE TABLE IF NOT EXISTS organization_members (
  organization_id      text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_account_id      text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  role                 text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_account_id)
);

CREATE INDEX IF NOT EXISTS organization_members_user_account_idx
  ON organization_members (user_account_id);

DROP TRIGGER IF EXISTS organization_members_set_updated_at
  ON organization_members;

CREATE TRIGGER organization_members_set_updated_at
  BEFORE UPDATE ON organization_members
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

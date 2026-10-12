CREATE TABLE IF NOT EXISTS organization_invitations (
  id                 text PRIMARY KEY CHECK (id ~ '^oiv_[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id    text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email              text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  role               text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  invited_by         text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  token_hash         text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

-- One open invitation per organization and normalized email. Closing the
-- previous invitation on resend is what keeps this index satisfiable, mirroring
-- the email verification and password reset token tables.
CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_one_open
  ON organization_invitations (organization_id, email)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS organization_invitations_organization_idx
  ON organization_invitations (organization_id);

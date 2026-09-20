CREATE TABLE refresh_tokens (
  id              text PRIMARY KEY CHECK (id ~ '^rft_[0-9A-HJKMNP-TV-Z]{26}$'),
  family_id       text NOT NULL CHECK (family_id ~ '^rfs_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  revoked_at      timestamptz,
  CHECK (expires_at > issued_at)
);

CREATE INDEX refresh_tokens_family_id
  ON refresh_tokens (family_id);

CREATE INDEX refresh_tokens_user_account_id
  ON refresh_tokens (user_account_id);

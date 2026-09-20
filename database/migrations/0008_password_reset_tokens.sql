CREATE TABLE password_reset_tokens (
  id              text PRIMARY KEY CHECK (id ~ '^prt_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX password_reset_one_open_token
  ON password_reset_tokens (user_account_id)
  WHERE consumed_at IS NULL;

CREATE INDEX password_reset_tokens_user_account_id
  ON password_reset_tokens (user_account_id);

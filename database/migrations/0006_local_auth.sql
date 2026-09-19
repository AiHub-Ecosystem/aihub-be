CREATE TABLE user_accounts (
  id         text PRIMARY KEY CHECK (id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
  username   text NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 32),
  status     text NOT NULL CHECK (status IN ('pending_verification', 'active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE auth_identities (
  id              text PRIMARY KEY CHECK (id ~ '^auth_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  provider        text NOT NULL CHECK (provider = 'password'),
  canonical_email text NOT NULL CHECK (char_length(canonical_email) BETWEEN 3 AND 320),
  password_hash   text NOT NULL CHECK (password_hash LIKE '$argon2id$v=19$m=65536,t=3,p=1$%'),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (provider, canonical_email)
);

CREATE TABLE email_verification_tokens (
  id              text PRIMARY KEY CHECK (id ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL
);

CREATE UNIQUE INDEX email_verification_one_open_token
  ON email_verification_tokens (user_account_id)
  WHERE consumed_at IS NULL;

CREATE INDEX auth_identities_user_account_id
  ON auth_identities (user_account_id);

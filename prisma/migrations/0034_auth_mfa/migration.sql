CREATE TABLE user_mfa_factors (
  factor_id        text PRIMARY KEY CHECK (factor_id ~ '^mfa_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_account_id  text NOT NULL UNIQUE REFERENCES user_accounts(id) ON DELETE RESTRICT,
  secret_key_id    text NOT NULL CHECK (secret_key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  secret_ciphertext text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'enabled')),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

CREATE TABLE user_mfa_recovery_codes (
  user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  code_hash       text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  PRIMARY KEY (user_account_id, code_hash)
);

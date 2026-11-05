CREATE TABLE user_access_token_revocations (
  issuer                text NOT NULL,
  jti                   text NOT NULL CHECK (length(jti) BETWEEN 1 AND 256),
  effective_expires_at  timestamptz NOT NULL,
  PRIMARY KEY (issuer, jti)
);

CREATE INDEX user_access_token_revocations_expiry_idx
  ON user_access_token_revocations (effective_expires_at);

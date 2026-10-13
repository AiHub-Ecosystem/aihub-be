-- Authentication email-recipient counters use Vault-backed, versioned HMACs.
-- A one-hour poller cleanup deletes rows after their fixed 24-hour window.
CREATE TABLE auth_email_recipient_rate_limits (
  key_version       text        NOT NULL,
  address_hmac      text        NOT NULL CHECK (address_hmac ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  request_count     integer     NOT NULL CHECK (request_count BETWEEN 1 AND 9),
  PRIMARY KEY (key_version, address_hmac),
  CHECK (expires_at = window_started_at + interval '24 hours')
);

CREATE INDEX auth_email_recipient_rate_limits_expires_idx
  ON auth_email_recipient_rate_limits (expires_at);

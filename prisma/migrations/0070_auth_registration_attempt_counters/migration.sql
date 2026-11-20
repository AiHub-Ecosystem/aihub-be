-- Registration attempts per normalized address, counted before the identity
-- conflict is decided (#1995). ADR-0178 accepts that a registration confirms an
-- existing active account, and requires evidence before any threshold exists;
-- this table is that counter and enforces nothing.
--
-- The address is kept only as a versioned, domain-separated HMAC, derived from
-- the retained Email Outbox keyring, exactly as
-- `auth_email_recipient_rate_limits` keeps its recipient fingerprints (ADR-0096).
-- A window is a fixed 24 hours from its first attempt and is cleaned up by the
-- same hourly pass that prunes the recipient counters.
CREATE TABLE auth_registration_attempt_counters (
  key_version       text        NOT NULL,
  address_hmac      text        NOT NULL CHECK (address_hmac ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  attempt_count     bigint      NOT NULL CHECK (attempt_count >= 1),
  PRIMARY KEY (key_version, address_hmac),
  CHECK (expires_at = window_started_at + interval '24 hours')
);

CREATE INDEX auth_registration_attempt_counters_expires_idx
  ON auth_registration_attempt_counters (expires_at);

-- ADR-0120: one row per observed Notification Event. Only references are kept;
-- the unique key is what makes the near-expiry sweep record a key once.
CREATE TABLE notification_events (
  id text PRIMARY KEY
    CHECK (id ~ '^nev_[0-9A-HJKMNP-TV-Z]{26}$'),
  kind text NOT NULL
    CHECK (kind IN ('api-key.near-expiry')),
  organization_id text NOT NULL
    REFERENCES organizations(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  api_key_id text NOT NULL
    REFERENCES api_keys(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  subject_expires_at timestamptz(6) NOT NULL,
  recorded_at timestamptz(6) NOT NULL,
  CONSTRAINT notification_events_subject_key
    UNIQUE (api_key_id, kind, subject_expires_at)
);

CREATE INDEX notification_events_organization_idx
  ON notification_events (organization_id);

-- The kind set only widens: the replacement below admits every kind the
-- dropped constraint did, and 0046 validates it.
ALTER TABLE email_delivery_requests
  DROP CONSTRAINT email_delivery_requests_kind_check; -- squawk-ignore ban-drop-constraint -- widened in the same transaction; approved: #608

ALTER TABLE email_delivery_requests
  ADD CONSTRAINT email_delivery_requests_kind_check CHECK (kind IN (
    'verification_email',
    'password_reset_email',
    'organization_invite_email',
    'mfa_enabled_notification',
    'mfa_removed_notification',
    'api_key_near_expiry_notification'
  )) NOT VALID;

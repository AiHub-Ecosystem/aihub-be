-- Durable handoff for transactional email dispatch (ADR-0074). The row is
-- written in the same PostgreSQL transaction as the account, token, or
-- invitation mutation it serves. Evidence columns must stay bounded and free
-- of email addresses, tokens, bodies, and raw provider responses; the message
-- payload exists only as authenticated ciphertext and is erased at every
-- terminal state.
CREATE TABLE email_delivery_requests (
  id                 text PRIMARY KEY CHECK (id ~ '^edr_[0-9A-HJKMNP-TV-Z]{26}$'),
  kind               text NOT NULL CHECK (kind IN (
                       'verification_email',
                       'password_reset_email',
                       'organization_invite_email')),
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'provider_accepted', 'failed', 'cancelled')),
  payload_ciphertext text,
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  last_attempt_at    timestamptz,
  -- Safe codes only: 'timeout', 'provider_rejected', 'credential_superseded',
  -- 'credential_expired', 'credential_revoked', 'not_actionable'. The pattern
  -- keeps free-text provider output out of the table.
  last_error_code    text CHECK (last_error_code ~ '^[a-z0-9_]{1,64}$'),
  cancel_reason      text CHECK (cancel_reason ~ '^[a-z0-9_]{1,64}$'),
  created_at         timestamptz NOT NULL,
  completed_at       timestamptz,
  CHECK ((payload_ciphertext IS NOT NULL) = (status = 'queued')),
  CHECK ((completed_at IS NOT NULL) = (status <> 'queued')),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CHECK (status <> 'provider_accepted' OR last_attempt_at IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX email_delivery_requests_status_created_idx
  ON email_delivery_requests (status, created_at);

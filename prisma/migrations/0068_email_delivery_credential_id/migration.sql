-- Email Delivery Request traceability (#441, TM-E5).
--
-- A request stored nothing that named what it was sent for, so support could
-- only tie a reset, verification, or invitation email to its cause by matching
-- timestamps. `credential_id` records the non-secret id of the token row or
-- invitation a credential-bearing request serves. It is an id, never a token
-- or token hash, so it outlives the payload: terminal transitions erase the
-- ciphertext but keep this column.
--
-- Notice kinds carry no credential and leave it NULL. Rows queued before this
-- migration, or by an N-1 writer during a rolling deploy, also stay NULL.
ALTER TABLE email_delivery_requests
  ADD COLUMN credential_id text
    CHECK (credential_id ~ '^(evt|prt|oiv)_[0-9A-HJKMNP-TV-Z]{26}$');

-- Migration 0027's inline comment listed cancel reasons as `last_error_code`
-- values. The codes the dispatcher actually writes are recorded here instead,
-- so the applied migration stays byte-identical.
COMMENT ON COLUMN email_delivery_requests.last_error_code IS
  'Bounded dispatch failure code: timeout, provider_rejected, provider_permanent_rejection, outcome_unknown, payload_unreadable, key_unavailable. Never a cancel reason.';
COMMENT ON COLUMN email_delivery_requests.cancel_reason IS
  'Why a queued request was cancelled before handoff: credential_expired (its credential expired) or not_actionable (consumed, superseded, revoked, missing, or a suspended Organization''s invitation). credential_superseded and credential_revoked are admitted for compatibility but no current writer produces them.';
COMMENT ON COLUMN email_delivery_requests.credential_id IS
  'Non-secret id of the verification token, password reset token, or organization invitation the request serves; NULL for notice kinds and for rows queued before #441.';

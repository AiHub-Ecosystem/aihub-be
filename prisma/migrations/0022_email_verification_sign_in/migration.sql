-- Verification Sign-in (ADR-0054). A verification token may carry the hash of
-- the Signup Browser Binding of the browser that requested it, and records the
-- one sign-in it may grant. Consumption (`consumed_at`, `consumed_reason`) is
-- unchanged: verification by anyone never spends the sign-in.
ALTER TABLE email_verification_tokens
  ADD COLUMN browser_binding_hash text
    CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN signed_in_at timestamptz;

ALTER TABLE email_verification_tokens
  ADD CONSTRAINT email_verification_sign_in_requires_verified
  CHECK (
    signed_in_at IS NULL
    OR (consumed_reason = 'verified' AND browser_binding_hash IS NOT NULL)
  );

-- ADR-0123: a verification token can require the password of the registration
-- it belongs to. `requires_password` is set when the token is issued; existing
-- rows and tokens issued while the deployment setting is off default to false.
-- `password_failures` counts wrong passwords, and the fifth spends the token
-- with the new `password_attempts` consumption reason.
--
-- Constraints are added NOT VALID so existing rows are not scanned on install;
-- 0050 validates them. The consumption-reason check is replaced by a wider one
-- rather than altered, so no write is ever unchecked.

ALTER TABLE email_verification_tokens
  ADD COLUMN requires_password boolean NOT NULL DEFAULT false,
  ADD COLUMN password_failures integer NOT NULL DEFAULT 0; -- squawk-ignore prefer-bigint-over-int -- a counter capped at 5 by a check; approved: #932

ALTER TABLE email_verification_tokens
  ADD CONSTRAINT email_verification_password_failures_check
  CHECK (password_failures BETWEEN 0 AND 5) NOT VALID;

ALTER TABLE email_verification_tokens
  ADD CONSTRAINT email_verification_consumption_reason_v2_check
  CHECK (
    (consumed_at IS NULL AND consumed_reason IS NULL)
    OR (
      consumed_at IS NOT NULL
      AND consumed_reason IS NOT NULL
      AND consumed_reason IN ('verified', 'superseded', 'password_attempts')
    )
  ) NOT VALID;

ALTER TABLE email_verification_tokens
  DROP CONSTRAINT email_verification_consumption_reason_check; -- squawk-ignore ban-drop-constraint -- widened by the _v2 check in this transaction; approved: #932

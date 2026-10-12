-- Claiming a terminal failure's notification has to exclude the other
-- instances, and losing that exclusion loses the alert entirely: once a row is
-- recorded as reported, no later pass will emit its metric or event again.
-- A stamp written at claim time therefore trades one lost alert for a
-- duplicated one.
--
-- The claim is a lease instead. `failure_notify_lease_expires_at` is what keeps
-- a second instance off the row while this one emits, and
-- `failure_reported_at` is written only after the callback returns. A process
-- that exits, or a callback that throws, leaves the row claimable again once the
-- lease lapses, so the alert is retried rather than lost.
ALTER TABLE email_delivery_requests
  ADD COLUMN failure_notify_lease_expires_at timestamptz;

COMMENT ON COLUMN email_delivery_requests.failure_reported_at IS
  'When the terminal-failure signal was emitted, not when it was claimed.';
COMMENT ON COLUMN email_delivery_requests.failure_notify_lease_expires_at IS
  'Until when this instance holds the right to emit that signal.';

ALTER TABLE email_delivery_requests
  DROP CONSTRAINT email_delivery_requests_failure_reported_check,
  ADD CONSTRAINT email_delivery_requests_failure_reported_check
    CHECK (failure_reported_at IS NULL OR status = 'failed');
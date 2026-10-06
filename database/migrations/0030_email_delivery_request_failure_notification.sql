-- The terminal-failure alert is a promise the outbox runbook makes, and a
-- process can exit between the commit that makes a request terminal and the
-- callback that emits the signal. `failure_reported_at` is the durable record
-- that the signal went out, so a later pass can reconcile the terminal rows
-- whose notification was lost instead of losing the alert for good.
--
-- It stays NULL for every non-terminal row, which also keeps the reconciling
-- query to the failed rows alone and leaves nothing for a cancelled or accepted
-- request to be mistaken for.
ALTER TABLE email_delivery_requests
  ADD COLUMN failure_reported_at timestamptz,
  ADD CONSTRAINT email_delivery_requests_failure_reported_check
    CHECK (failure_reported_at IS NULL OR status = 'failed');

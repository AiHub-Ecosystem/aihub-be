-- Lease coordinates the pollers ADR-0074 puts in every instance: a claim takes
-- the row for a fixed window, so a second instance skips it and a restart finds
-- it reclaimable once the window lapses. Both columns are nullable so rows that
-- were already queued before this migration stay claimable, and both are cleared
-- when a row leaves `queued`, so a terminal row never carries a stale lease.
ALTER TABLE email_delivery_requests
  ADD COLUMN lease_owner text
    CHECK (lease_owner IS NULL OR lease_owner ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'),
  ADD COLUMN lease_expires_at timestamptz;
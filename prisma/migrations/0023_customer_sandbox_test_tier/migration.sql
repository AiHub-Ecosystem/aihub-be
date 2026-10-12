-- Sandbox API-key identity is read from the control plane. Idempotency and
-- usage remain local to the Sandbox database and therefore cannot reference
-- an Organization row that intentionally is not copied into that database.
ALTER TABLE idempotency_records
  DROP CONSTRAINT IF EXISTS idempotency_records_organization_id_fkey;

CREATE TABLE IF NOT EXISTS sandbox_dispatch_reservations (
  request_id      text PRIMARY KEY,
  organization_id text NOT NULL,
  month_start     date NOT NULL,
  status          text NOT NULL DEFAULT 'reserved'
                  CHECK (status IN ('reserved', 'released')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  CHECK ((status = 'reserved' AND released_at IS NULL)
      OR (status = 'released' AND released_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS sandbox_dispatch_reservations_month_idx
  ON sandbox_dispatch_reservations (month_start, organization_id)
  WHERE status = 'reserved';

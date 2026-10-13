-- Sandbox dispatch allowance policy (ADR-0095).
--
-- `sandbox_allowance_defaults` is the persisted default per UTC calendar month.
-- The effective default for a month is the latest row at or before it, which is
-- what makes "the new default starts in the month after deployment" a stored
-- fact rather than a code change. The deployment month keeps the allowance that
-- was already effective (25); the following month carries the new default of 5.
--
-- `sandbox_allowance_overrides` is one Organization's total allowance for one
-- specific UTC month. It replaces the default for that month rather than adding
-- to it, and it expires with the month: no row means the persisted default
-- applies. Editing a row never resets consumption, because consumption lives in
-- `sandbox_dispatch_reservations`.
CREATE TABLE sandbox_allowance_defaults (
  month_start date PRIMARY KEY,
  allowance   integer NOT NULL CHECK (allowance >= 0)
);

CREATE TABLE sandbox_allowance_overrides (
  organization_id text NOT NULL,
  month_start     date NOT NULL,
  allowance       integer NOT NULL CHECK (allowance >= 0),
  PRIMARY KEY (organization_id, month_start)
);

-- The deployment month keeps the allowance that was already effective (25), and
-- the following month carries the new default of 5. Both months are derived
-- from the moment the migration runs, so deploying late does not move the
-- change onto a month that has already been in effect. `DO NOTHING` leaves an
-- allowance an operator already set for that month untouched.
INSERT INTO sandbox_allowance_defaults (month_start, allowance)
SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date, 25
ON CONFLICT (month_start) DO NOTHING;

INSERT INTO sandbox_allowance_defaults (month_start, allowance)
SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')::date, 5
ON CONFLICT (month_start) DO NOTHING;
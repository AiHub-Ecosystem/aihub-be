-- Billing statements, adjustments and closed months (ADR-0097, #404), and the
-- separate charge for a Writing grading completed after its 504 (#405).

-- Which event a usage record bills. `response` is the request the customer
-- received; `background_completion` is the one charge for a grading AIHUB
-- finished after answering 504. Existing rows all describe a response.
ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS billing_basis text NOT NULL DEFAULT 'response'
  CHECK (billing_basis IN ('response', 'background_completion'));

-- A key AIHUB itself uses (smoke tests, canaries, operator checks). Its traffic
-- is metered as usual but left off a customer's statement.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT false;

-- A correction to what an Organization is billed for one UTC month. Usage
-- records are billing evidence and are never edited (#393), so a credit or a
-- debit is its own row: who made it, why, and what it corrects.
CREATE TABLE billing_adjustments (
  id              text        PRIMARY KEY CHECK (id ~ '^badj_[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id text        NOT NULL REFERENCES organizations (id),
  billing_month   date        NOT NULL CHECK (extract(day FROM billing_month) = 1),
  operation       text        NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 128),
  requests        integer     NOT NULL CHECK (requests <> 0),
  reason          text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  corrects        jsonb       NOT NULL CHECK (jsonb_typeof(corrects) = 'object'),
  actor           text        NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 128),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_adjustments_org_month_idx
  ON billing_adjustments (organization_id, billing_month);

-- What a closed month billed, per Organization and operation. A later prune,
-- redaction or restore can change the usage rows; it cannot change these.
CREATE TABLE billing_month_closures (
  organization_id     text        NOT NULL REFERENCES organizations (id),
  billing_month       date        NOT NULL CHECK (extract(day FROM billing_month) = 1),
  operation           text        NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 128),
  billable_requests   integer     NOT NULL CHECK (billable_requests >= 0),
  adjustment_requests integer     NOT NULL,
  total_requests      integer     NOT NULL,
  closed_by           text        NOT NULL CHECK (char_length(closed_by) BETWEEN 1 AND 128),
  closed_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, billing_month, operation),
  CHECK (total_requests = billable_requests + adjustment_requests)
);

-- Both billing tables only ever grow: a wrong adjustment is answered by
-- another adjustment, and a closed month is compared, never rewritten.
CREATE OR REPLACE FUNCTION billing_records_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_adjustments_append_only
  BEFORE UPDATE OR DELETE ON billing_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION billing_records_append_only();

CREATE TRIGGER billing_month_closures_append_only
  BEFORE UPDATE OR DELETE ON billing_month_closures
  FOR EACH ROW
  EXECUTE FUNCTION billing_records_append_only();

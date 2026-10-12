ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS actor_scope text NOT NULL DEFAULT '';

ALTER TABLE idempotency_records
  DROP CONSTRAINT IF EXISTS idempotency_records_pkey;

ALTER TABLE idempotency_records
  ADD CONSTRAINT idempotency_records_pkey
  PRIMARY KEY (organization_id, operation, actor_scope, idempotency_key);

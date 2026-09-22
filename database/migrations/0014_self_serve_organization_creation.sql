-- Self-serve Organization creation. ADR-0041 records the boundary.

-- Who created a Self-serve Organization; null for operator-provisioned ones.
-- The Organization Creation Limit counts rows here rather than audit events,
-- because audit events are pruned and the allowance must never regrow.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS created_by_user_account_id text
  REFERENCES user_accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS organizations_created_by_idx
  ON organizations (created_by_user_account_id)
  WHERE created_by_user_account_id IS NOT NULL;

-- An Account Idempotency Scope names no Organization, because the mutation it
-- guards is the one that creates it. A primary key cannot hold a null column,
-- so the key becomes a unique constraint that treats null as one value.
ALTER TABLE idempotency_records
  DROP CONSTRAINT IF EXISTS idempotency_records_pkey;

ALTER TABLE idempotency_records
  ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE idempotency_records
  DROP CONSTRAINT IF EXISTS idempotency_records_scope_key;

ALTER TABLE idempotency_records
  ADD CONSTRAINT idempotency_records_scope_key
  UNIQUE NULLS NOT DISTINCT (organization_id, operation, actor_scope, idempotency_key);

-- The first event whose target is the Organization itself. Both lists are
-- restated in full, as migration 0012 did, so two slices cannot collide.
ALTER TABLE organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_action_check;

ALTER TABLE organization_audit_events
  ADD CONSTRAINT organization_audit_events_action_check CHECK (action IN (
    'organization.created',
    'invitation.sent',
    'invitation.resent',
    'invitation.accepted',
    'invitation.revoked',
    'membership.role_changed',
    'membership.disabled',
    'membership.owner_transferred',
    'api_key.created',
    'api_key.rotated',
    'api_key.revoked'));

ALTER TABLE organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_target_type_check;

ALTER TABLE organization_audit_events
  ADD CONSTRAINT organization_audit_events_target_type_check
  CHECK (target_type IN ('organization', 'membership', 'invitation', 'api_key'));

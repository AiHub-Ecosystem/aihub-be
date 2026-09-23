-- Organization suspension and restoration. ADR-0044 records the boundary.

-- Restated in full, as migrations 0012, 0014, and 0015 did, so two slices
-- cannot collide.
ALTER TABLE organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_action_check;

ALTER TABLE organization_audit_events
  ADD CONSTRAINT organization_audit_events_action_check CHECK (action IN (
    'organization.created',
    'organization.renamed',
    'organization.suspended',
    'organization.restored',
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

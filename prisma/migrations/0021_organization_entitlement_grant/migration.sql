-- Operator-granted Organization entitlements are recorded as durable audit acts.
ALTER TABLE organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_action_check;

ALTER TABLE organization_audit_events
  ADD CONSTRAINT organization_audit_events_action_check CHECK (action IN (
    'organization.created',
    'organization.renamed',
    'organization.suspended',
    'organization.restored',
    'organization.identity_config_set',
    'organization.entitlement_granted',
    'invitation.sent',
    'invitation.resent',
    'invitation.accepted',
    'invitation.revoked',
    'membership.role_changed',
    'membership.disabled',
    'membership.owner_transferred',
    'membership.owner_attached',
    'api_key.created',
    'api_key.rotated',
    'api_key.revoked'));

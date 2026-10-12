-- Add the first invitation revocation action to the durable audit vocabulary.
-- ADR-0036 records why revocation shares the invitation close signal while
-- still receiving its own applied/denied audit action.
ALTER TABLE organization_audit_events
  DROP CONSTRAINT IF EXISTS organization_audit_events_action_check;

ALTER TABLE organization_audit_events
  ADD CONSTRAINT organization_audit_events_action_check CHECK (action IN (
    'invitation.sent',
    'invitation.resent',
    'invitation.accepted',
    'invitation.revoked',
    'membership.role_changed',
    'membership.disabled',
    'membership.owner_transferred',
    'api_key.created',
    'api_key.rotated',
    'api_key.revoked'
  ));

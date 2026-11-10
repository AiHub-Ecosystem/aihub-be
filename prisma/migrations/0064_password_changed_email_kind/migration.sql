-- Widen the durable delivery-kind set before deploying password-change
-- notifications. Preserve every existing kind in the replacement constraint.
ALTER TABLE email_delivery_requests
  DROP CONSTRAINT email_delivery_requests_kind_check; -- squawk-ignore ban-drop-constraint -- widened in the same transaction; approved: #388

ALTER TABLE email_delivery_requests
  ADD CONSTRAINT email_delivery_requests_kind_check CHECK (kind IN (
    'verification_email',
    'password_reset_email',
    'organization_invite_email',
    'mfa_enabled_notification',
    'mfa_removed_notification',
    'api_key_near_expiry_notification',
    'password_changed_notification'
  )) NOT VALID;

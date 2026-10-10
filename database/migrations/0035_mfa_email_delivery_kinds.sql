ALTER TABLE email_delivery_requests
  DROP CONSTRAINT email_delivery_requests_kind_check;

ALTER TABLE email_delivery_requests
  ADD CONSTRAINT email_delivery_requests_kind_check CHECK (kind IN (
    'verification_email',
    'password_reset_email',
    'organization_invite_email',
    'mfa_enabled_notification',
    'mfa_removed_notification'
  ));

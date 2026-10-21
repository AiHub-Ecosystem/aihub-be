ALTER TABLE email_delivery_requests
  ADD COLUMN organization_id text,
  ADD COLUMN inviter_id text,
  ADD CONSTRAINT email_delivery_requests_invitation_fair_share_ids_check
    CHECK (
      (organization_id IS NULL AND inviter_id IS NULL)
      OR (
        kind = 'organization_invite_email'
        AND organization_id IS NOT NULL
        AND inviter_id IS NOT NULL
      )
    ) NOT VALID;

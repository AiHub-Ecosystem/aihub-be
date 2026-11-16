export const ORGANIZATION_INVITATION_EMAIL_RATE_LIMIT = {
  scope: 'organization_invitation_email',
  limit: 3,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * The 30-day session lifetime: the Web Session's sliding inactivity window, the
 * Refresh Token's expiry and the refresh cookie's max age are all this one
 * value, so they cannot end at different moments.
 */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** The durable Web Session identity and sliding inactivity lifetime (ADR-0081). */
export const WEB_SESSION_POLICY = {
  prefix: 'wbs_',
  ttlMs: SESSION_LIFETIME_MS,
} as const;

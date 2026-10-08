/** The durable Web Session identity and sliding inactivity lifetime (ADR-0081). */
export const WEB_SESSION_POLICY = {
  prefix: 'wbs_',
  ttlMs: 30 * 24 * 60 * 60 * 1000,
} as const;

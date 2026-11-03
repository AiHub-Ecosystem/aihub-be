export const WRITING_CHART_MAX_BYTES = 10 * 1024 * 1024;
export const WRITING_CHART_MAX_PIXELS = 20_000_000;
export const WRITING_CHART_INTENT_TTL_MS = 60 * 60 * 1000;
// Shares the intent TTL's value but is a separate policy: the rolling
// per-Organization limit survives changes to how long an intent stays open.
export const WRITING_CHART_RATE_WINDOW_MS = 60 * 60 * 1000;
export const WRITING_CHART_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export const WRITING_CHART_RETENTION_MS = 24 * 60 * 60 * 1000;
export const WRITING_CHART_ORG_HOURLY_LIMIT = 5;
// Longer than the completion route's 10-second deadline: a publication that
// began earlier has been aborted and can no longer write the public object, so
// a revocation need not wait for it (#1206).
export const WRITING_CHART_PUBLICATION_LEASE_MS = 30 * 1000;

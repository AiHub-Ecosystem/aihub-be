/**
 * The retry-budget window: one window of first attempts, over which admitted
 * same-key repeats and the refusal hint are measured.
 */
const RETRY_BUDGET_WINDOW_MS = 60_000;

/**
 * The Organization retry-budget policy the graded-admission script applies.
 * Application owns these values so they can be tested without Redis; the
 * adapter only forwards them to the script.
 */
export interface OrganizationRetryBudgetPolicy {
  /**
   * Distinct Idempotency-Keys remembered per Organization. A safety bound, not
   * capacity: an unbounded rolling-day ledger can fill shared Redis until
   * `noeviction` breaks every write (#371).
   */
  readonly seenKeyCap: number;
  readonly windowMs: number;
  /** Redis TTL of the first-attempt and repeat windows. */
  readonly windowTtlSeconds: number;
  /** How long a seen key keeps its place in the ledger. */
  readonly retentionMs: number;
  /** Redis TTL of the seen-key ledger, with a minute of clock slack. */
  readonly retentionTtlSeconds: number;
  /** Admitted repeats allowed per first attempt in the window. */
  readonly repeatAllowanceRatio: number;
}

export const ORGANIZATION_RETRY_BUDGET_POLICY: OrganizationRetryBudgetPolicy = {
  seenKeyCap: 10_000,
  windowMs: RETRY_BUDGET_WINDOW_MS,
  windowTtlSeconds: 120,
  retentionMs: 86_400_000,
  retentionTtlSeconds: 86_460,
  repeatAllowanceRatio: 0.1,
};

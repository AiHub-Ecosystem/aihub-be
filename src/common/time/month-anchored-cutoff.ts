/**
 * The one month-anchored cutoff: `months` before `now`, keeping the time of day
 * and clamping to the target month's last day, so a January 31 never lands on a
 * nonexistent February 31. Each retention rule states its own length beside the
 * policy that owns it and computes its cutoff through this helper (ADR-0023).
 * The caller rejects an invalid clock before calling.
 */
export function calculateMonthAnchoredCutoff(now: Date, months: number): Date {
  const originalDay = now.getUTCDate();
  const cutoff = new Date(now.getTime());
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return cutoff;
}

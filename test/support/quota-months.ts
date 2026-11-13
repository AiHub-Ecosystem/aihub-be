/** `YYYY-MM` of the UTC month `monthsBack` before the month containing `ms`. */
export function monthOf(ms: number, monthsBack = 0): string {
  const at = new Date(ms);
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - monthsBack, 1),
  )
    .toISOString()
    .slice(0, 7);
}

/** The first millisecond of the UTC month after the one containing `ms`. */
export function startOfNextMonth(ms: number): number {
  const at = new Date(ms);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/**
 * A count is a whole number that can be added up without losing anything:
 * a quota counter, a request tally, a token tally.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger`, because the difference
 * between them is the whole point: a value above `Number.MAX_SAFE_INTEGER` is
 * an integer as far as `Number.isInteger` is concerned, and a counter the
 * admission guard accepted could then be refused when reconciliation read it
 * back. `>= 0` because a count is a quantity, and a negative one is not a
 * quantity that failed to arrive, it is a value that is wrong.
 */
export function isUsableCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

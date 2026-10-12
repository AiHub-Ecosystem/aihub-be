export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The count a `::bigint` aggregate yields, or `undefined` when it is not a safe
 * non-negative integer. Prisma's raw path returns `bigint` where `pg` returned a
 * decimal string, and both are accepted.
 */
export function safeNonNegativeCount(value: unknown): number | undefined {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
          ? Number(value)
          : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

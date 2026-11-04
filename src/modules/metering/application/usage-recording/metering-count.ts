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

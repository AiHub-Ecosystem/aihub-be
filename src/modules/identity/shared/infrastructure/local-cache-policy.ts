export function shortenedTtl(maxTtl: number): number {
  const random = Math.min(0.999_999_999, Math.max(0, Math.random()));
  return Math.floor(maxTtl * (0.5 + random * 0.5));
}

export function putBounded<K, V>(
  entries: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > limit) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

export function percentile(samples: number[], fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError('percentile fraction must be between 0 and 1');
  }
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)] ?? null;
}

export function summarizeLatency(samples: number[]) {
  return {
    sampleCount: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
}

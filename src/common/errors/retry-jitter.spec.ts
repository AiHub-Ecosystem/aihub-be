import { OUTAGE_RETRY_AFTER_MS, outageRetryAfterMs } from './retry-jitter';

describe('outageRetryAfterMs', () => {
  it('spreads refusals made with different draws inside [base, base + 1 s)', () => {
    const early = outageRetryAfterMs(() => 0.1);
    const late = outageRetryAfterMs(() => 0.9);

    expect(early).not.toBe(late);
    for (const hint of [early, late]) {
      expect(hint).toBeGreaterThanOrEqual(OUTAGE_RETRY_AFTER_MS);
      expect(hint).toBeLessThan(OUTAGE_RETRY_AFTER_MS + 1_000);
    }
  });

  it('never goes below the base at zero jitter', () => {
    expect(outageRetryAfterMs(() => 0)).toBe(OUTAGE_RETRY_AFTER_MS);
  });

  it('keeps a longer remaining cooldown as the floor', () => {
    expect(outageRetryAfterMs(() => 0, 30_000)).toBe(30_000);
    expect(outageRetryAfterMs(() => 0.5, 30_000)).toBe(30_500);
  });
});

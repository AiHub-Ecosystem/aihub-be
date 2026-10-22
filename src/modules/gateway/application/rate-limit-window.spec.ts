import { RATE_WINDOW_MS, rateLimitWindow } from './rate-limit-window';

const NOW = 1_782_000_000_000;

describe('rateLimitWindow', () => {
  it('keeps one fixed one-minute window per key', () => {
    const window = rateLimitWindow('ak_1', NOW);
    const resetAt = NOW + window.resetInMs;

    expect(window.resetInMs).toBeGreaterThan(0);
    expect(window.resetInMs).toBeLessThanOrEqual(RATE_WINDOW_MS);
    expect(rateLimitWindow('ak_1', resetAt - 1).index).toBe(window.index);
    expect(rateLimitWindow('ak_1', resetAt)).toEqual({
      index: window.index + 1,
      resetInMs: RATE_WINDOW_MS,
    });
  });

  it('does not reset every key at the same instant', () => {
    const resets = new Set(
      Array.from({ length: 20 }, (_, key) =>
        String(NOW + rateLimitWindow(`ak_${key}`, NOW).resetInMs),
      ),
    );

    expect(resets.size).toBeGreaterThan(10);
  });
});

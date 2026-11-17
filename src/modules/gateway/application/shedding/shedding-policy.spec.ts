import { SHEDDING_POLICY, SheddingPolicy } from './shedding-policy';

describe('SheddingPolicy', () => {
  it('sheds the lowest tier first and both tiers at full utilization', () => {
    const policy = new SheddingPolicy();

    expect(policy.observe(0.5, 0)).toBe(0);
    expect(policy.observe(SHEDDING_POLICY.enterShedLevel1, 1_000)).toBe(1);
    expect(policy.observe(SHEDDING_POLICY.enterShedLevel2, 2_000)).toBe(2);
  });

  it('never escalates two tiers in the same second', () => {
    const policy = new SheddingPolicy();

    expect(policy.observe(0.95, 0)).toBe(1);
    expect(policy.observe(2, 100)).toBe(1);
    expect(policy.observe(2, 1_000)).toBe(2);
  });

  it('holds a tier until the host stays below the recovery share for the window', () => {
    const policy = new SheddingPolicy();
    expect(policy.observe(1, 0)).toBe(2);

    // A single dip between two spikes does not restore anything.
    expect(policy.observe(0.4, 1_000)).toBe(2);
    expect(policy.observe(0.9, 2_000)).toBe(2);

    // A sustained window restores one tier, not both.
    expect(policy.observe(0.4, 3_000)).toBe(2);
    expect(policy.observe(0.4, 3_000 + SHEDDING_POLICY.recoverAfterMs)).toBe(1);
    // Restoring a tier restarts the window: the next one needs its own 20 s.
    expect(
      policy.observe(0.4, 3_000 + SHEDDING_POLICY.recoverAfterMs + 1_000),
    ).toBe(1);
    expect(
      policy.observe(0.4, 3_000 + 2 * SHEDDING_POLICY.recoverAfterMs),
    ).toBe(0);
  });

  it('restarts the recovery window when load returns', () => {
    const policy = new SheddingPolicy();
    expect(policy.observe(1, 0)).toBe(2);
    expect(policy.observe(0.5, 1_000)).toBe(2);
    expect(policy.observe(0.8, 10_000)).toBe(2);
    expect(policy.observe(0.5, 11_000)).toBe(2);
    expect(policy.observe(0.5, 11_000 + SHEDDING_POLICY.recoverAfterMs)).toBe(
      1,
    );
  });

  it('ignores a non-finite sample', () => {
    const policy = new SheddingPolicy();
    expect(policy.observe(Number.NaN, 0)).toBe(0);
    expect(policy.observe(Number.POSITIVE_INFINITY, 1_000)).toBe(0);
  });
});

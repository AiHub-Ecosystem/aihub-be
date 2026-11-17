export const SHEDDING_POLICY = Object.freeze({
  /** Shed best-effort above this share of the adaptive limit. */
  enterShedLevel1: 0.9,
  /** Also shed standard above this share. */
  enterShedLevel2: 1,
  /** Restore one tier only below this share. */
  recoverBelow: 0.75,
  /** The share must stay below `recoverBelow` for this long. */
  recoverAfterMs: 20_000,
  /** Wait between changes, so a jump never escalates or restores more than one tier at once. */
  escalationIntervalMs: 1_000,
});

/**
 * How much load the gateway refuses, as the number of lowest tiers shed:
 * `0` sheds nothing, `1` sheds `best-effort`, `2` sheds `standard` too.
 *
 * `critical` is never shed. A refused authentication or billing request is a
 * caller who cannot even learn it should slow down, and the work it saves is
 * small: the expensive dispatch is what saturates the host.
 */
export class SheddingPolicy {
  private level = 0;
  // Never transitioned: the spacing applies between changes, not to the first.
  private lastTransitionAt = Number.NEGATIVE_INFINITY;
  private belowSince: number | undefined;

  /**
   * Folds one capacity sample in, and returns the level to apply now.
   *
   * `utilization` is in-flight work over the adaptive limit of the same origin,
   * so `1` means the limiter is already refusing. Entering sheds at once;
   * leaving needs the host to stay below the recovery share for the whole
   * window, so a sample that merely dipped between two spikes cannot restore a
   * tier that the next spike will shed again.
   */
  observe(utilization: number, nowMs: number): number {
    if (!Number.isFinite(utilization)) {
      return this.level;
    }

    const target = this.targetLevelFor(utilization);
    if (target > this.level) {
      if (
        nowMs - this.lastTransitionAt <
        SHEDDING_POLICY.escalationIntervalMs
      ) {
        return this.level;
      }
      // One tier per change: a first sample at full utilization must not skip
      // `best-effort` shedding entirely and refuse `standard` traffic.
      this.level = Math.min(target, this.level + 1);
      this.lastTransitionAt = nowMs;
      this.belowSince = undefined;
      return this.level;
    }

    if (target === this.level) {
      this.belowSince = undefined;
      return this.level;
    }

    if (utilization >= SHEDDING_POLICY.recoverBelow) {
      this.belowSince = undefined;
      return this.level;
    }

    this.belowSince ??= nowMs;
    if (nowMs - this.belowSince < SHEDDING_POLICY.recoverAfterMs) {
      return this.level;
    }

    this.level -= 1;
    this.lastTransitionAt = nowMs;
    this.belowSince = nowMs;
    return this.level;
  }

  private targetLevelFor(utilization: number): number {
    if (utilization >= SHEDDING_POLICY.enterShedLevel2) return 2;
    if (utilization >= SHEDDING_POLICY.enterShedLevel1) return 1;
    return 0;
  }
}

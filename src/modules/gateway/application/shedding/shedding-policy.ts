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

export interface SheddingThresholds {
  readonly enterShedLevel1: number;
  readonly enterShedLevel2: number;
  readonly recoverBelow: number;
  readonly recoverAfterMs: number;
  readonly escalationIntervalMs: number;
}

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

  constructor(
    private readonly thresholds: SheddingThresholds = SHEDDING_POLICY,
  ) {}

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
        this.thresholds.escalationIntervalMs
      ) {
        return this.level;
      }
      this.level = target;
      this.lastTransitionAt = nowMs;
      this.belowSince = undefined;
      return this.level;
    }

    if (target === this.level) {
      this.belowSince = undefined;
      return this.level;
    }

    if (utilization >= this.thresholds.recoverBelow) {
      this.belowSince = undefined;
      return this.level;
    }

    this.belowSince ??= nowMs;
    if (nowMs - this.belowSince < this.thresholds.recoverAfterMs) {
      return this.level;
    }

    this.level -= 1;
    this.lastTransitionAt = nowMs;
    this.belowSince = nowMs;
    return this.level;
  }

  currentLevel(): number {
    return this.level;
  }

  private targetLevelFor(utilization: number): number {
    if (utilization >= this.thresholds.enterShedLevel2) return 2;
    if (utilization >= this.thresholds.enterShedLevel1) return 1;
    return 0;
  }
}

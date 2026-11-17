/**
 * The shedding level every application instance applies.
 *
 * The level is shared so one instance that sees the host saturate does not shed
 * alone while its peers keep admitting the same work (ADR-0168, ADR-0172).
 * Reads are served from process memory and refreshed on a timer, so a refusal
 * never waits on Redis.
 */
export interface SheddingLevelPort {
  /**
   * The level to apply now: this instance's own, or a peer's if it is higher.
   * Called on every request, so it must never await.
   */
  current(): number;
}

export const SHEDDING_LEVEL = Symbol('SHEDDING_LEVEL');

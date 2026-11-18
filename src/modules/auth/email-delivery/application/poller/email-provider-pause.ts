import type { EmailProviderOutageCircuitPort } from '@/modules/auth/email-delivery/application/email-provider-outage-circuit.port';

/** Retry a reservation outage on the next poll pass without spending an attempt. */
export const EMAIL_SEND_RATE_LIMIT_RETRY_MS = 5_000;

/**
 * This poller's view of the shared provider outage circuit (ADR-0122): the
 * instant before which it starts no provider call, and the probe bookkeeping
 * that keeps a failed Redis write from stranding every other poller.
 */
export class EmailProviderPause {
  /** Epoch milliseconds; no claim and no provider call before it. */
  until = 0;

  constructor(
    private readonly circuit: EmailProviderOutageCircuitPort,
    private readonly now: () => Date,
  ) {}

  extend(untilMs: number): void {
    this.until = Math.max(this.until, untilMs);
  }

  async releaseProbe(probeToken: string | undefined): Promise<void> {
    if (probeToken === undefined) return;
    try {
      await this.circuit.releaseProbe(probeToken);
    } catch {
      // Redis expires the probe lock with its bounded recovery TTL, and the
      // acquire script takes over a probe held past its stale margin (#1113).
    }
  }

  /** Records a provider-wide failure and returns how long to hold the row. */
  async open(
    retryAfterMs: number,
    openedAt: Date,
    probeToken?: string,
  ): Promise<number> {
    try {
      const circuitDelayMs = await this.circuit.recordProviderFailure(
        retryAfterMs,
        probeToken,
      );
      const safeDelayMs =
        Number.isSafeInteger(circuitDelayMs) && circuitDelayMs >= 0
          ? Math.max(retryAfterMs, circuitDelayMs)
          : Math.max(retryAfterMs, EMAIL_SEND_RATE_LIMIT_RETRY_MS);
      this.extend(openedAt.getTime() + safeDelayMs);
      return safeDelayMs;
    } catch {
      // Nothing reached shared state, so the probe this attempt held would
      // strand every poller until the outage key expires (#1113).
      await this.releaseProbe(probeToken);
      const fallbackDelayMs = Math.max(
        retryAfterMs,
        EMAIL_SEND_RATE_LIMIT_RETRY_MS,
      );
      this.extend(openedAt.getTime() + fallbackDelayMs);
      return fallbackDelayMs;
    }
  }

  async close(probeToken?: string): Promise<void> {
    try {
      await this.circuit.recordProviderReachable();
    } catch {
      // The state this DEL failed to clear still holds the probe, and a held
      // probe strands every poller until it is released or taken over (#1113).
      await this.releaseProbe(probeToken);
      this.extend(this.now().getTime() + EMAIL_SEND_RATE_LIMIT_RETRY_MS);
    }
  }
}

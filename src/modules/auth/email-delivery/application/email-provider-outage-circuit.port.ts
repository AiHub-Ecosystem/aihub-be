export type EmailProviderSendPermit =
  | {
      readonly allowed: true;
      readonly probeToken?: string;
      /**
       * The circuit's failure count when the permit was granted. A success
       * clears the circuit only while it still matches, so a cooldown a newer
       * failure wrote while this send was in flight survives it (#441).
       */
      readonly generation?: number;
    }
  | { readonly allowed: false; readonly retryAfterMs: number };

/** Coordinates the temporary Resend outage circuit across all poller instances. */
export interface EmailProviderOutageCircuitPort {
  acquireSendPermit(): Promise<EmailProviderSendPermit>;
  releaseProbe(probeToken: string): Promise<void>;
  recordProviderFailure(
    retryAfterMs: number,
    probeToken?: string,
  ): Promise<number>;
  /** Clears the circuit unless a failure was recorded after `sent` began. */
  recordProviderReachable(sent?: {
    readonly generation?: number;
    readonly probeToken?: string;
  }): Promise<void>;
  readOutageDurationMs(): Promise<number>;
}

export const EMAIL_PROVIDER_OUTAGE_CIRCUIT = Symbol(
  'EMAIL_PROVIDER_OUTAGE_CIRCUIT',
);

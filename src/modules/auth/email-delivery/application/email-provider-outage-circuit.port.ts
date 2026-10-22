export type EmailProviderSendPermit =
  | { readonly allowed: true; readonly probeToken?: string }
  | { readonly allowed: false; readonly retryAfterMs: number };

/** Coordinates the temporary Resend outage circuit across all poller instances. */
export interface EmailProviderOutageCircuitPort {
  acquireSendPermit(): Promise<EmailProviderSendPermit>;
  releaseProbe(probeToken: string): Promise<void>;
  recordProviderFailure(
    retryAfterMs: number,
    probeToken?: string,
  ): Promise<number>;
  recordProviderReachable(): Promise<void>;
  readOutageDurationMs(): Promise<number>;
}

export const EMAIL_PROVIDER_OUTAGE_CIRCUIT = Symbol(
  'EMAIL_PROVIDER_OUTAGE_CIRCUIT',
);

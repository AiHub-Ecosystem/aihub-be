import type { EmailDeliveryKind } from './email-kind-handler.registry';

/**
 * Whether the credential a queued request still names can be handed to a
 * provider. `closed` covers every durable close the owning table records —
 * consumed, superseded, and revoked alike — because none of the three tables
 * keeps which one it was, and the dispatch decision is the same either way.
 */
export type EmailCredentialState =
  | 'actionable'
  | 'expired'
  | 'closed'
  | 'missing';

export interface EmailCredentialActionabilityPort {
  check(input: {
    readonly kind: EmailDeliveryKind;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<EmailCredentialState>;
}

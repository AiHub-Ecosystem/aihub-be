import type { OrganizationInviteEmailInput } from './email-sender.port';

export type EmailDeliveryKind =
  | 'verification_email'
  | 'password_reset_email'
  | 'organization_invite_email';

/**
 * What a worker needs once it claims a request: the inputs the matching
 * `EmailSenderPort` call takes. It exists only inside the ciphertext, which is
 * why the expiry is an ISO string rather than a `Date`.
 *
 * The two shapes are one type because the row's `kind` column already says
 * which sender call the payload belongs to: only the organization invitation
 * names an organization and a role.
 */
export interface AuthEmailDeliveryPayload {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface OrganizationInviteEmailDeliveryPayload
  extends AuthEmailDeliveryPayload {
  readonly organizationName: string;
  /** The same three roles `EmailSenderPort` accepts for an invitation. */
  readonly role: OrganizationInviteEmailInput['role'];
}

export type EmailDeliveryPayload =
  | AuthEmailDeliveryPayload
  | OrganizationInviteEmailDeliveryPayload;

export interface InsertEmailDeliveryRequestInput {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
  readonly payloadCiphertext: string;
  readonly createdAt: Date;
}

/**
 * The only way an Email Delivery Request's payload can be sealed and read back.
 * A worker that claims a row resolves the key version from the envelope itself.
 */
export interface EmailPayloadCipher {
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
}

export const EMAIL_PAYLOAD_CIPHER = Symbol('EMAIL_PAYLOAD_CIPHER');

export type EmailDeliveryRequestStatus =
  | 'queued'
  | 'provider_accepted'
  | 'failed'
  | 'cancelled';

/** The bounded codes the table's own checks admit; nothing else is stored. */
export type EmailDeliveryErrorCode = 'timeout' | 'provider_rejected';

export type EmailDeliveryCancelReason =
  | 'credential_expired'
  | 'credential_superseded'
  | 'credential_revoked'
  | 'not_actionable';

export interface EmailDeliveryRequestRecord {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
  readonly status: EmailDeliveryRequestStatus;
  readonly payloadCiphertext: string | null;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/**
 * One poller's share of the queue. `owner` names this instance and appears on
 * every row it holds, so a lease can be released or recognised after a restart;
 * `now` is the caller's clock, which keeps retry scheduling testable.
 */
export interface ClaimEmailDeliveryRequestsInput {
  readonly owner: string;
  readonly limit: number;
  readonly leaseMs: number;
  readonly now: Date;
}

/**
 * The outbox as the dispatcher sees it: lease-protected claims in, terminal
 * transitions out. Every method is safe to call on a row another instance has
 * already moved on; the row's `status` guard is what makes that true.
 */
export interface EmailDispatchStorePort {
  claim(
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]>;
  markProviderAccepted(input: {
    readonly id: string;
    readonly attemptedAt: Date;
  }): Promise<void>;
  markFailed(input: {
    readonly id: string;
    readonly failedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
  }): Promise<void>;
  markCancelled(input: {
    readonly id: string;
    readonly cancelledAt: Date;
    readonly reason: EmailDeliveryCancelReason;
  }): Promise<void>;
  recordFailedAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
  }): Promise<void>;
}

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

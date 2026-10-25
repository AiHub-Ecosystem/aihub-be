/**
 * Each vocabulary is declared as the runtime list the table's own checks
 * mirror, and the union is derived from it. A repository validating a row
 * reads the same list, so a column outside the vocabulary is refused rather
 * than widened into the record.
 */
export const EMAIL_DELIVERY_KINDS = [
  'verification_email',
  'password_reset_email',
  'organization_invite_email',
  'mfa_enabled_notification',
  'mfa_removed_notification',
  'api_key_near_expiry_notification',
] as const;

export type EmailDeliveryKind = (typeof EMAIL_DELIVERY_KINDS)[number];

/**
 * How far ahead the near-expiry sweep looks, and so how long its notice stays
 * worth sending: by the end of the window every key it lists has expired
 * (ADR-0120). It replaces the one-day credential cutoff for that kind.
 */
export const API_KEY_NEAR_EXPIRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Only references are sealed. Who receives it, which keys are still active,
 * and what they are called are read again at dispatch (ADR-0120).
 */
export interface ApiKeyNearExpiryNotificationPayload {
  readonly organizationId: string;
  readonly userAccountId: string;
  readonly apiKeyIds: readonly string[];
}

/**
 * Recognizes a near-expiry notice payload after decryption, so the module
 * that decides which queued notices a withdrawal supersedes (#1098) fails
 * loudly on a shape change instead of silently skipping the cancellation.
 */
export function isApiKeyNearExpiryNotificationPayload(
  value: unknown,
): value is ApiKeyNearExpiryNotificationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.organizationId === 'string' &&
    candidate.organizationId.length > 0 &&
    typeof candidate.userAccountId === 'string' &&
    candidate.userAccountId.length > 0 &&
    Array.isArray(candidate.apiKeyIds) &&
    candidate.apiKeyIds.length > 0 &&
    candidate.apiKeyIds.every((id) => typeof id === 'string' && id.length > 0)
  );
}

/** What the notice is composed from once its facts are read at dispatch. */
export interface ApiKeyNearExpiryNotificationInput {
  readonly email: string;
  readonly organizationId: string;
  readonly organizationName: string;
  /** Never empty: a notice with no active key left is not sent. */
  readonly apiKeys: readonly {
    readonly id: string;
    readonly name: string;
    readonly expiresAt: Date;
  }[];
}

/**
 * Answers for a notice whose facts live in another module. `undefined` means
 * nothing is left to tell: the recipient or Organization no longer qualifies,
 * or no listed key is still active.
 */
export interface ApiKeyNearExpiryNoticeResolverPort {
  /**
   * The facts to compose the notice from, or nothing when it is not actionable.
   * When the Organization is no longer active, it also withdraws the notice's
   * events, so restoring the Organization inside the window notifies it again
   * (#996).
   */
  resolve(
    payload: ApiKeyNearExpiryNotificationPayload,
    now: Date,
  ): Promise<ApiKeyNearExpiryNotificationInput | undefined>;
}

/**
 * Filled by the module that owns each notice's facts when it is constructed,
 * because that module imports Auth and Auth cannot import it back. A process
 * that never fills a slot leaves those requests queued rather than guessing.
 */
export interface EmailNoticeResolvers {
  apiKeyNearExpiry?: ApiKeyNearExpiryNoticeResolverPort;
}

export const EMAIL_NOTICE_RESOLVERS = Symbol('EMAIL_NOTICE_RESOLVERS');

/**
 * What a worker needs once it claims a request: the inputs the matching Auth
 * email composer needs. It exists only inside the ciphertext, which is why the
 * expiry is an ISO string rather than a `Date`.
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
  /**
   * The same three roles the invitation email composer accepts. Spelled out
   * rather than imported from it, because the composer reads this port.
   */
  readonly role: 'owner' | 'admin' | 'member';
  readonly inviterUsername?: string;
}

export interface MfaSecurityNotificationPayload {
  readonly email: string;
}

export type EmailDeliveryPayload =
  | AuthEmailDeliveryPayload
  | OrganizationInviteEmailDeliveryPayload
  | MfaSecurityNotificationPayload
  | ApiKeyNearExpiryNotificationPayload;

export declare const emailDeliveryTransactionBrand: unique symbol;

/** Opaque capability for the caller-owned PostgreSQL transaction. */
export interface EmailDeliveryTransaction {
  readonly [emailDeliveryTransactionBrand]?: unknown;
}

/**
 * The only way an Email Delivery Request is written. The outbox table belongs
 * to this module (ADR-0074), so another module that commits a request with its
 * own mutation goes through this port rather than holding a copy of the insert,
 * which would drift the first time the table changed.
 */
export interface EmailDeliveryRequestWriterPort {
  reserveAuthenticationEmailRecipient(
    transaction: EmailDeliveryTransaction,
    input: { readonly email: string; readonly now: Date },
  ): Promise<boolean>;
  insert(
    transaction: EmailDeliveryTransaction,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void>;
  /**
   * The still-queued, unclaimed requests of one kind, for a caller that must
   * decide from their payloads which of them its own withdrawal supersedes
   * (#1098). Their ciphertexts are returned unopened; the caller owns the
   * payload's meaning.
   */
  queuedPayloadCiphertexts(
    transaction: EmailDeliveryTransaction,
    input: { readonly kind: EmailDeliveryKind },
  ): Promise<
    readonly { readonly id: string; readonly payloadCiphertext: string }[]
  >;
  /**
   * Cancels requests no dispatch has claimed, recording why. A claim in flight
   * is left to finish: its own dispatch decides the row's outcome.
   */
  cancelQueued(
    transaction: EmailDeliveryTransaction,
    input: {
      readonly ids: readonly string[];
      readonly reason: EmailDeliveryCancelReason;
      readonly cancelledAt: Date;
    },
  ): Promise<void>;
}

export const EMAIL_DELIVERY_REQUEST_WRITER = Symbol(
  'EMAIL_DELIVERY_REQUEST_WRITER',
);

/**
 * The `edr_` namespace, bound once by the module so a use case receives a
 * mint function instead of importing one. Mints from the caller's `now`, so
 * the id a request is committed with carries the same instant as its row.
 */
export const EMAIL_DELIVERY_ID = Symbol('EMAIL_DELIVERY_ID');

interface InsertEmailDeliveryRequestBase {
  readonly id: string;
  readonly payloadCiphertext: string;
  readonly createdAt: Date;
}

export type InsertEmailDeliveryRequestInput =
  | (InsertEmailDeliveryRequestBase & {
      readonly kind: 'organization_invite_email';
      readonly organizationId: string;
      readonly inviterId: string;
    })
  | (InsertEmailDeliveryRequestBase & {
      readonly kind: Exclude<EmailDeliveryKind, 'organization_invite_email'>;
    });

/**
 * The only way an Email Delivery Request's payload can be sealed and read back.
 * A worker that claims a row resolves the key version from the envelope itself.
 * Named for the record it owns, the way every other durable record port is.
 */
export interface EmailPayloadCipherPort {
  encrypt(plaintext: string, context: EmailPayloadContext): string;
  decrypt(envelope: string, context: EmailPayloadContext): string;
}

/**
 * What a sealed payload belongs to. An envelope is authenticated against it, so
 * a ciphertext moved to another row or kind does not open (ADR-0074).
 */
export interface EmailPayloadContext {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
}

/**
 * One failure kind for every AES-256-GCM envelope in the module, so a caller
 * decides what a failure means from its kind rather than from the concrete
 * thrown type. `unknown-key` becomes `key_unavailable`; malformed and
 * unreadable envelopes become `payload_unreadable`.
 */
export type EnvelopeCipherFailureKind =
  | 'malformed'
  | 'unknown-key'
  | 'unreadable';

export class EnvelopeCipherError extends Error {
  constructor(
    readonly kind: EnvelopeCipherFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'EnvelopeCipherError';
  }
}

/**
 * The envelope names a key version this instance no longer holds. The poller
 * treats this as an operator-visible terminal failure, distinct from corruption.
 */
export class EmailPayloadUnknownKeyVersionError extends EnvelopeCipherError {
  constructor() {
    super('unknown-key', 'email outbox key version is unknown');
    this.name = 'EmailPayloadUnknownKeyVersionError';
  }
}

export const EMAIL_PAYLOAD_CIPHER = Symbol('EMAIL_PAYLOAD_CIPHER');

export const EMAIL_DELIVERY_REQUEST_STATUSES = [
  'queued',
  'provider_accepted',
  'failed',
  'cancelled',
] as const;

export type EmailDeliveryRequestStatus =
  (typeof EMAIL_DELIVERY_REQUEST_STATUSES)[number];

/** The bounded codes the table's own checks admit; nothing else is stored. */
export const EMAIL_DELIVERY_ERROR_CODES = [
  'timeout',
  'provider_rejected',
  'provider_permanent_rejection',
  'outcome_unknown',
  'payload_unreadable',
  // Deploy readers before the poller starts writing this value (#266).
  'key_unavailable',
] as const;

export type EmailDeliveryErrorCode =
  (typeof EMAIL_DELIVERY_ERROR_CODES)[number];

export const EMAIL_DELIVERY_CANCEL_REASONS = [
  'credential_expired',
  'credential_superseded',
  'credential_revoked',
  'not_actionable',
] as const;

export type EmailDeliveryCancelReason =
  (typeof EMAIL_DELIVERY_CANCEL_REASONS)[number];

export interface EmailDeliveryRequestRecord {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
  readonly status: EmailDeliveryRequestStatus;
  readonly payloadCiphertext: string | null;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  readonly lastErrorCode: EmailDeliveryErrorCode | null;
  readonly cancelReason: EmailDeliveryCancelReason | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/**
 * A terminal request claimed for its failure report. `claim` is the lease
 * expiry the claim wrote. A later claim is only possible once that instant has
 * passed, and writes a strictly later one, so it identifies this claim and no
 * other: acknowledging and releasing require it (#989).
 */
export interface ClaimedFailureReport extends EmailDeliveryRequestRecord {
  readonly claim: Date;
}

/** Queued rows of `kinds` created at or before `createdAtOrBefore`. */
export interface CancelStaleEmailDeliveryRequestsInput {
  readonly at: Date;
  readonly createdAtOrBefore: Date;
  readonly kinds: readonly EmailDeliveryKind[];
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

export interface ReleaseUnspentEmailAttemptInput {
  readonly id: string;
  readonly owner: string;
  readonly previousAttempts: number;
  readonly previousAttemptAt: Date | null;
  readonly retryAt: Date;
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
  /**
   * Counts the attempt before the provider is called, durably, and refuses a row
   * that has used its three. Counting it here rather than in the transition that
   * follows the call is what makes the cap a cap: a transition that fails leaves
   * the attempt spent, so no pass can reach the provider a fourth time.
   */
  /**
   * Every transition below carries the claimer's identity. A batch can outlive its
   * lease under a database stall or a paused process, and a claim that lapsed and
   * was taken by another instance must not be writable by the first one: it would
   * spend an attempt the new owner is spending, or clear the new owner's lease.
   * Requiring `owner` to still hold the row is what makes the lease a fence and
   * not a hint, so an update that matched nothing is a lost race rather than a
   * second writer.
   */
  reserveAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly owner: string;
  }): Promise<void>;
  /** Reverts a known non-consuming provider response and defers the row atomically. */
  releaseUnspentAttempt(input: ReleaseUnspentEmailAttemptInput): Promise<void>;
  markProviderAccepted(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly owner: string;
  }): Promise<void>;
  markFailed(input: {
    readonly id: string;
    readonly failedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void>;
  markCancelled(input: {
    readonly id: string;
    readonly cancelledAt: Date;
    readonly reason: EmailDeliveryCancelReason;
    readonly owner: string;
  }): Promise<void>;
  recordFailedAttempt(input: {
    readonly id: string;
    readonly attemptedAt: Date;
    readonly errorCode: EmailDeliveryErrorCode;
    readonly owner: string;
  }): Promise<void>;
  /**
   * Hands a claimed request back without recording an outcome, for one this
   * instance cannot finish yet. No attempt is spent and the payload stays, so the
   * next instance to claim it starts where this one stopped rather than
   * inheriting a terminal state. It is not claimable again before `retryAt`: a
   * row released for immediate reclaim would come back every pass and, once a
   * batch's worth of them existed, keep every other request from being claimed.
   */
  releaseDeferred(input: {
    readonly id: string;
    readonly owner: string;
    readonly retryAt: Date;
  }): Promise<void>;
  /**
   * Cancels queued requests created at or before `createdAtOrBefore` whose lease
   * has lapsed, and erases their payload, without opening it. Every credential an
   * Email Delivery Request carries has expired by then, so the request can never
   * be sent; this is what erases a payload no instance can decrypt (ADR-0074).
   */
  cancelStale(
    input: CancelStaleEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]>;
  /**
   * Requests that spent their last attempt without a recorded outcome, whose
   * lease has lapsed. They are given up as `failed` rather than dispatched
   * again: the attempt cap is the cap, and a row nothing else will move must not
   * keep its payload or stay silent.
   */
  failExhausted(input: {
    readonly at: Date;
  }): Promise<readonly EmailDeliveryRequestRecord[]>;
  /**
   * Terminal requests whose notification was never recorded, oldest first, so a
   * pass that starts after the one that failed them still emits their alert. The
   * row is no longer claimable by then, which is exactly why the durable record
   * has to be readable on its own.
   *
   * Claiming them is part of the call, and it takes a lease rather than marking
   * them reported: two instances reconciling at once produce one event between
   * them, while an instance that dies before emitting leaves the row claimable
   * again when the lease lapses. `markFailureReported` is what ends the sequence.
   *
   * Reporting is at least once, not exactly once: the signal is emitted before
   * the report is recorded, and they are not one transaction. A report whose
   * record fails is claimed and emitted again (#989).
   */
  claimUnreportedFailures(input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<readonly ClaimedFailureReport[]>;
  /**
   * Records the report, only while `claim` is still the row's claim: a
   * reporter whose lease lapsed and was claimed again changes nothing.
   */
  markFailureReported(input: {
    readonly id: string;
    readonly claim: Date;
    readonly reportedAt: Date;
  }): Promise<void>;
  /**
   * Hands a claim back without emitting, for a callback that threw. Without it
   * the row would stay invisible until the lease lapsed. Only the current
   * claim can hand it back.
   */
  releaseFailureNotification(input: {
    readonly id: string;
    readonly claim: Date;
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

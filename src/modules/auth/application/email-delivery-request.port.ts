import type { OrganizationInviteEmailInput } from './email-sender.port';

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
] as const;

export type EmailDeliveryKind = (typeof EMAIL_DELIVERY_KINDS)[number];

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

/**
 * The one thing writing a request needs from the caller's open transaction:
 * running a statement. Any module's transaction handle satisfies it, which is
 * what lets a mutation in another module commit its Email Delivery Request
 * atomically without that module knowing the table.
 *
 * `query(text, values)` is SQL-shaped on purpose: the port was chosen so a
 * second store can hand this module its own open transaction, and a
 * transaction is only portable if it can run a statement on it. An opaque
 * infrastructure-created handle would be the cleaner boundary — the writer
 * could take a callback instead of a SQL string — but it only pays for itself
 * if a second store actually needs to write a request. One implementation
 * today, so the SQL shape stays until someone writes the second caller.
 */
export interface EmailDeliveryTransaction {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}

/**
 * The only way an Email Delivery Request is written. The outbox table belongs
 * to this module (ADR-0074), so another module that commits a request with its
 * own mutation goes through this port rather than holding a copy of the insert,
 * which would drift the first time the table changed.
 */
export interface EmailDeliveryRequestWriterPort {
  insert(
    transaction: EmailDeliveryTransaction,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void>;
}

export const EMAIL_DELIVERY_REQUEST_WRITER = Symbol(
  'EMAIL_DELIVERY_REQUEST_WRITER',
);

export interface InsertEmailDeliveryRequestInput {
  readonly id: string;
  readonly kind: EmailDeliveryKind;
  readonly payloadCiphertext: string;
  readonly createdAt: Date;
}

/**
 * The only way an Email Delivery Request's payload can be sealed and read back.
 * A worker that claims a row resolves the key version from the envelope itself.
 * Named for the record it owns, the way every other durable record port is.
 */
export interface EmailPayloadCipherPort {
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
}

/**
 * The envelope names a key version this instance holds no key for, which is what
 * an instance that started before a rotation sees when it claims a row another
 * instance sealed afterwards. It is not a broken payload: the row stays queued
 * and unerased, because the instance that does hold the key can still open it.
 */
export class EmailPayloadUnknownKeyVersionError extends Error {
  constructor() {
    super('email outbox key version is unknown');
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
  'outcome_unknown',
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
  cancelStale(input: {
    readonly at: Date;
    readonly createdAtOrBefore: Date;
  }): Promise<readonly EmailDeliveryRequestRecord[]>;
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
   */
  claimUnreportedFailures(input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<readonly EmailDeliveryRequestRecord[]>;
  markFailureReported(input: {
    readonly id: string;
    readonly reportedAt: Date;
  }): Promise<void>;
  /**
   * Hands a claim back without emitting, for a callback that threw. Without it
   * the row would stay invisible until the lease lapsed.
   */
  releaseFailureNotification(input: {
    readonly id: string;
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

/**
 * One provider attempt gets one explicit timeout (ADR-0074). The poller sizes
 * its lease from this number, so it lives beside the call it bounds rather than
 * beside the clock that waits for it.
 */
export const EMAIL_ATTEMPT_TIMEOUT_MS = 5_000;

export interface VerificationEmailInput {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface PasswordResetEmailInput {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface OrganizationInviteEmailInput {
  readonly email: string;
  readonly organizationName: string;
  readonly role: 'owner' | 'admin' | 'member';
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Dispatch metadata rather than message content. The idempotency key is stable
 * per Email Delivery Request, so an attempt whose outcome the poller never
 * learns can be retried without the provider sending the same email twice.
 */
export interface EmailDispatchOptions {
  readonly idempotencyKey?: string;
}

export interface EmailSenderPort {
  sendVerificationEmail(
    input: VerificationEmailInput,
    options?: EmailDispatchOptions,
  ): Promise<void>;
  sendPasswordResetEmail(
    input: PasswordResetEmailInput,
    options?: EmailDispatchOptions,
  ): Promise<void>;
  sendOrganizationInviteEmail(
    input: OrganizationInviteEmailInput,
    options?: EmailDispatchOptions,
  ): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

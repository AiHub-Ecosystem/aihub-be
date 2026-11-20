/**
 * One provider attempt gets one explicit timeout (ADR-0074). The poller sizes
 * its lease from this number, so it lives beside the call it bounds rather than
 * beside the clock that waits for it.
 */
export const EMAIL_ATTEMPT_TIMEOUT_MS = 5_000;

/** Finished provider-independent content composed by the Auth application. */
export interface EmailMessage {
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * Dispatch metadata rather than message content. The idempotency key is stable
 * per Email Delivery Request, so an attempt whose outcome the poller never
 * learns can be retried without the provider sending the same email twice.
 */
export interface EmailDispatchOptions {
  readonly idempotencyKey?: string;
}

/**
 * Which idempotency conflict a provider `409` reported (#441). `concurrent`
 * means a request under the same key is still being processed; `payload_changed`
 * means an earlier request under the key carried a different payload, so that
 * earlier handoff may already have been accepted.
 */
export type EmailIdempotencyConflict = 'concurrent' | 'payload_changed';

/** The only response metadata dispatch policy may inspect or retain. */
export interface EmailProviderResponse {
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly idempotencyConflict?: EmailIdempotencyConflict;
}

export interface EmailSenderPort {
  send(
    message: EmailMessage,
    options?: EmailDispatchOptions,
  ): Promise<EmailProviderResponse>;
}

/** A rejection from the configured provider fetch, without retaining its body. */
export class EmailProviderTransportError extends Error {
  constructor() {
    super('Email provider transport failed');
    this.name = 'EmailProviderTransportError';
  }
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

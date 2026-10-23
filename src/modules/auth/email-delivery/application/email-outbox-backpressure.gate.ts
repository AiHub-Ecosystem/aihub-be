import { AppError } from '@/common/errors/app-error';
import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';

import { jitteredRetryAfterMs } from '@/common/errors/retry-jitter';

import type {
  AdmitEmailRequestPort,
  BackpressureEmailKind,
  EmailOutboxQueueAgePort,
} from './email-outbox-backpressure.port';

/**
 * A request is refused once the backlog has used this share of the lifetime of
 * the credential it would mint: a 24-hour token refuses past 18 hours of
 * backlog, a one-hour reset token past 45 minutes. What remains is the margin
 * the new request needs to be sent and read.
 */
const BACKLOG_SHARE_OF_LIFETIME = 0.75;

export const BACKPRESSURE_MIN_RETRY_MS = 30_000;
export const BACKPRESSURE_MAX_RETRY_MS = 15 * 60_000;

const CREDENTIAL_LIFETIME_MS: Record<BackpressureEmailKind, number> = {
  verification_email: OPAQUE_TOKEN_BINDINGS.verification.ttlMs,
  password_reset_email: OPAQUE_TOKEN_BINDINGS.passwordReset.ttlMs,
  organization_invite_email: OPAQUE_TOKEN_BINDINGS.organizationInvite.ttlMs,
};

/**
 * Sheds an email request at the request boundary when the outbox cannot get it
 * out within its credential's lifetime, instead of acknowledging it and
 * cancelling it later (ADR-0074). It reads the queue age and writes nothing, so
 * a refusal leaves no account, token, or delivery request behind.
 *
 * An unreadable measurement admits the request: refusing every sign-up because
 * a gauge is missing is the worse failure.
 */
export class EmailOutboxBackpressureGate implements AdmitEmailRequestPort {
  constructor(
    private readonly queueAge: EmailOutboxQueueAgePort,
    private readonly onRefusal: (kind: BackpressureEmailKind) => void,
    private readonly random: () => number = Math.random,
  ) {}

  async admit(kind: BackpressureEmailKind): Promise<void> {
    let ageSeconds: number | undefined;
    try {
      ageSeconds = await this.queueAge.oldestQueuedAgeSeconds(kind);
    } catch {
      return;
    }
    const ageMs = (ageSeconds ?? 0) * 1000;
    const lifetimeMs = CREDENTIAL_LIFETIME_MS[kind];
    if (
      !Number.isFinite(ageMs) ||
      ageMs < lifetimeMs * BACKLOG_SHARE_OF_LIFETIME
    ) {
      return;
    }

    this.onRefusal(kind);
    // The oldest request leaves the queue when it is sent or expires, so the
    // wait that matters is the time it has left, bounded so a client re-checks.
    throw new AppError({
      code: 'EMAIL_DELIVERY_BACKLOGGED',
      message: 'Email delivery is delayed; try again later',
      retryable: true,
      retryAfterMs: jitteredRetryAfterMs(
        Math.min(
          BACKPRESSURE_MAX_RETRY_MS,
          Math.max(BACKPRESSURE_MIN_RETRY_MS, lifetimeMs - ageMs),
        ),
        this.random,
      ),
    });
  }
}

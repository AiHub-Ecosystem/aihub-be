import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { ORGANIZATION_INVITATION_EMAIL_RATE_LIMIT } from '@/modules/auth/rate-limit/public/organization-invitation-email-rate-limit';

export async function invitationRecipientRetryAfterMs(
  rateLimiter: AuthRateLimiterPort | undefined,
  recipient: string,
  fallbackMs: number,
): Promise<number | undefined> {
  if (rateLimiter === undefined) return fallbackMs;
  try {
    const decision = await rateLimiter.consume({
      ...ORGANIZATION_INVITATION_EMAIL_RATE_LIMIT,
      key: recipient,
    });
    if (decision.allowed) return undefined;
    const retryAfterMs = decision.retryAfterMs;
    return typeof retryAfterMs === 'number' &&
      Number.isSafeInteger(retryAfterMs) &&
      retryAfterMs >= 0
      ? retryAfterMs
      : ORGANIZATION_INVITATION_EMAIL_RATE_LIMIT.windowMs;
  } catch {
    return fallbackMs;
  }
}

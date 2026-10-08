import { AppError } from '@/common/errors/app-error';
import { type AuthRateLimiterPort } from './auth-rate-limiter.port';
import { type VerificationTokenPort } from './verification-token.port';

/**
 * The policy both Verification Sign-in routes share. A token is verified by
 * two callers — the browser-facing `verify-email` and the Customer Web BFF — and
 * both run the same one `verify_ip` limit, so the BFF route adds no way around
 * it.
 */
const VERIFICATION_RATE_LIMITS = {
  ip: { scope: 'verify_ip', limit: 10, windowMs: 5 * 60 * 1000 },
} as const;

export async function enforceVerificationRateLimit(
  rateLimiter: AuthRateLimiterPort,
  ip: string,
): Promise<void> {
  const result = await rateLimiter.consume({
    ...VERIFICATION_RATE_LIMITS.ip,
    key: ip,
  });
  if (!result.allowed) {
    throw new AppError({
      code: 'RATE_LIMITED',
      message: 'Too many requests',
      retryable: true,
      ...(result.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.retryAfterMs }),
    });
  }
}

/**
 * The Signup Browser Binding is stored and compared only as a hash, and the
 * hash is the one function that issued the token, so the two routes cannot
 * drift onto different ones.
 */
export function browserBindingHash(
  tokens: VerificationTokenPort,
  browserBinding: string | undefined,
): { readonly browserBindingHash?: string } {
  return browserBinding === undefined
    ? {}
    : { browserBindingHash: tokens.hash(browserBinding) };
}

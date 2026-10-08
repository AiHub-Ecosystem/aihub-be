import { enforceAuthRateLimit } from './auth-rate-limit';
import { type AuthRateLimiterPort } from './auth-rate-limiter.port';
import { type VerificationTokenPort } from './verification-token.port';

/** Browser verification uses the peer IP; BFF verification uses the token hash. */
const VERIFICATION_RATE_LIMITS = {
  ip: { scope: 'verify_ip', limit: 10, windowMs: 5 * 60 * 1000 },
  token: {
    scope: 'web_session_verification_token',
    limit: 10,
    windowMs: 5 * 60 * 1000,
  },
} as const;

export async function enforceVerificationRateLimit(
  rateLimiter: AuthRateLimiterPort,
  ip: string,
): Promise<void> {
  await enforceAuthRateLimit(rateLimiter, {
    ...VERIFICATION_RATE_LIMITS.ip,
    key: ip,
  });
}

export async function enforceWebSessionVerificationRateLimit(
  rateLimiter: AuthRateLimiterPort,
  tokenHash: string,
): Promise<void> {
  await enforceAuthRateLimit(rateLimiter, {
    ...VERIFICATION_RATE_LIMITS.token,
    key: tokenHash,
  });
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

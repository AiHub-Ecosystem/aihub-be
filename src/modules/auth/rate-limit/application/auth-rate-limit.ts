import { AppError } from '@/common/errors/app-error';
import type { AuthRateLimiterPort } from './auth-rate-limiter.port';

type AuthRateLimit = Parameters<AuthRateLimiterPort['consume']>[0];
type AuthRateLimitDecision = Awaited<
  ReturnType<AuthRateLimiterPort['consume']>
>;

/**
 * The one refusal every authentication budget answers with, because ADR-0096
 * promises the same answer on every route: `429 RATE_LIMITED`, retryable, the
 * wait in `retry_after_ms`, and `Retry-After` on the response.
 *
 * The header is asked for here rather than by each caller, so an integrator that
 * honours it cannot tell login from verification from password recovery. The
 * filter emits it only when there is a wait to send, which is why a refusal that
 * knows no wait carries no `retry_after_ms` either.
 */
function authRateLimited(retryAfterMs: number | undefined): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Too many requests',
    retryable: true,
    retryAfterHeader: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * Several dimensions can refuse the same request, and the wait the caller must
 * observe is the longest one still standing. Reporting a shorter one invites a
 * retry that is refused again, and a refusal that is wrong about when to come
 * back is worse than one that admits it does not know.
 */
function longestWaitStanding(
  decisions: readonly AuthRateLimitDecision[],
): number | undefined {
  let longest: number | undefined;
  for (const decision of decisions) {
    if (decision.allowed || decision.retryAfterMs === undefined) {
      continue;
    }
    longest =
      longest === undefined
        ? decision.retryAfterMs
        : Math.max(longest, decision.retryAfterMs);
  }
  return longest;
}

function refuseIfRateLimited(
  decisions: readonly AuthRateLimitDecision[],
): void {
  if (decisions.some((decision) => !decision.allowed)) {
    throw authRateLimited(longestWaitStanding(decisions));
  }
}

async function applyRateLimits(
  limiter: AuthRateLimiterPort,
  limits: readonly AuthRateLimit[],
  verb: 'check' | 'consume',
): Promise<void> {
  const decisions: AuthRateLimitDecision[] = [];
  for (const limit of limits) {
    decisions.push(await limiter[verb](limit));
  }
  refuseIfRateLimited(decisions);
}

/**
 * Reads every dimension without spending any of them, as ADR-0096 requires of
 * the gate in front of password and second-factor proof: a caller that is
 * admitted is not charged for the admission.
 */
export async function checkAuthRateLimits(
  limiter: AuthRateLimiterPort,
  limits: readonly AuthRateLimit[],
): Promise<void> {
  await applyRateLimits(limiter, limits, 'check');
}

/**
 * Spends every dimension, then refuses once. The refusal is built after the last
 * dimension rather than at the first one, so the wait it reports is the whole
 * picture; a dimension left unspent behind a refusal would hand the next attempt
 * a fresh budget on the very bucket the caller was told to wait out.
 */
export async function enforceAuthRateLimits(
  limiter: AuthRateLimiterPort,
  limits: readonly AuthRateLimit[],
): Promise<void> {
  await applyRateLimits(limiter, limits, 'consume');
}

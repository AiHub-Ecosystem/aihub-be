import { parseRetryAfter } from '@/common/http/retry-after';

/** Provider throttling without a Retry-After header uses this bounded delay. */
export const EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS = 60_000;

export function emailProviderRetryAfterMs(
  value: string | undefined,
  now: Date,
): number {
  return parseRetryAfter(value, now) ?? EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS;
}

import { AppError } from '@/common/errors/app-error';
import type { AuthRateLimiterPort } from './auth-rate-limiter.port';

export async function enforceAuthRateLimit(
  limiter: AuthRateLimiterPort,
  input: Parameters<AuthRateLimiterPort['consume']>[0],
): Promise<void> {
  const result = await limiter.consume(input);
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

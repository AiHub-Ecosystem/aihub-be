import type { ExecutionContext } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { RATE_WINDOW_MS } from '@/modules/gateway/application/rate-limit-window';
import type { RateLimitStanding } from '@/modules/gateway/application/rate-limiter.port';

/**
 * The caller's own per-key limit, in the `RateLimit-Policy` and `RateLimit`
 * fields of draft-ietf-httpapi-ratelimit-headers-11, so a client can slow
 * down before it is refused. Only the key's own figures are ever reported.
 */
export function reportStanding(
  context: ExecutionContext,
  standing: RateLimitStanding | undefined,
): void {
  if (standing === undefined) return;
  const reply = context.switchToHttp().getResponse<FastifyReply>();
  reply.header(
    'RateLimit-Policy',
    `"per-key";q=${standing.limit};w=${RATE_WINDOW_MS / 1_000}`,
  );
  reply.header(
    'RateLimit',
    `"per-key";r=${standing.remaining};t=${Math.ceil(standing.resetInMs / 1_000)}`,
  );
}

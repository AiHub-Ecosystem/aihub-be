import type { ExecutionContext } from '@nestjs/common';

import { getMetrics } from '@/common/observability/metrics';
import type { RateLimiterPort } from '@/modules/gateway/application/rate-limiter.port';
import { RateLimitGuard } from './rate-limit.guard';

const authenticated = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: 5,
  hardStopOnQuota: false,
  allowedEnvironments: ['production'],
} as const;

const standing = { limit: 600, remaining: 41, resetInMs: 12_001 };

function contextFor(headers = new Map<string, string>()): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ aihubAuth: authenticated }),
      getResponse: () => ({
        header: (name: string, value: string) => headers.set(name, value),
      }),
    }),
  } as ExecutionContext;
}

async function rejectedCount(reason: string): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith(`aihub_rejected_total{reason="${reason}"} `),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

describe('RateLimitGuard', () => {
  it('limits a route outside the graded chain by the key limit', async () => {
    const consume = jest.fn<
      ReturnType<RateLimiterPort['consume']>,
      Parameters<RateLimiterPort['consume']>
    >(async () => ({ allowed: true }));
    const guard = new RateLimitGuard({ consume });

    await expect(guard.canActivate(contextFor())).resolves.toBe(true);

    expect(consume).toHaveBeenCalledWith({
      keyId: authenticated.apiKeyId,
      limit: authenticated.rateLimitRpm,
    });
  });

  it('reports the per-key standing of an admitted request in the RateLimit fields', async () => {
    const headers = new Map<string, string>();
    const guard = new RateLimitGuard({
      consume: async () => ({ allowed: true, standing }),
    });

    await guard.canActivate(contextFor(headers));

    expect(Object.fromEntries(headers)).toEqual({
      'RateLimit-Policy': '"per-key";q=600;w=60',
      RateLimit: '"per-key";r=41;t=13',
    });
  });

  it('reports the standing on a 429 too, next to the retry hint', async () => {
    const before = await rejectedCount('rate_limit');
    const headers = new Map<string, string>();
    const guard = new RateLimitGuard({
      consume: async () => ({
        allowed: false,
        retryAfterMs: 12_500,
        standing: { ...standing, remaining: 0 },
      }),
    });

    await expect(guard.canActivate(contextFor(headers))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 12_500,
    });
    expect(headers.get('RateLimit')).toBe('"per-key";r=0;t=13');
    expect(await rejectedCount('rate_limit')).toBe(before + 1);
  });
});

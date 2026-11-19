import { createHash } from 'node:crypto';

import { registry } from '@/common/observability/metrics';

import { RedisDpopReplayCache } from './redis-dpop-replay-cache';

async function seamCount(): Promise<number> {
  const line = (await registry.metrics())
    .split('\n')
    .find((entry) =>
      entry.startsWith('aihub_redis_unavailable_total{seam="dpop_replay"}'),
    );
  // A series that does not exist yet counts as zero, never as NaN: NaN + 1 equals NaN.
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

type SetCall = readonly [string, string, 'EX', number, 'NX'];

function fakeRedis(results: ('OK' | null)[]) {
  const calls: SetCall[] = [];
  return {
    calls,
    redis: {
      set: async (...args: SetCall) => {
        calls.push(args);
        return results.shift() ?? null;
      },
      quit: async () => 'OK',
    },
  };
}

const KEY = { issuer: 'https://api.test', jkt: 'thumb', jti: 'proof-1' };

describe('RedisDpopReplayCache', () => {
  it('claims a proof once: SET NX with the TTL, keyed by a digest rather than the raw jti', async () => {
    const { redis, calls } = fakeRedis(['OK', null]);
    const cache = new RedisDpopReplayCache(redis);

    await expect(cache.claim(KEY, 180)).resolves.toBe(true);
    await expect(cache.claim(KEY, 180)).resolves.toBe(false);

    const digest = createHash('sha256')
      .update('https://api.test\nthumb\nproof-1')
      .digest('hex');
    expect(calls[0]).toEqual([
      `aihub:auth:dpop-replay:${digest}`,
      '1',
      'EX',
      180,
      'NX',
    ]);
  });

  it('lets a Redis failure reach the caller instead of answering for it, and counts it under its seam', async () => {
    const failure = new Error('redis down');
    const cache = new RedisDpopReplayCache({
      set: () => Promise.reject(failure),
      quit: async () => 'OK',
    });
    const before = await seamCount();

    await expect(cache.claim(KEY, 180)).rejects.toBe(failure);

    expect(await seamCount()).toBe(before + 1);
  });
});

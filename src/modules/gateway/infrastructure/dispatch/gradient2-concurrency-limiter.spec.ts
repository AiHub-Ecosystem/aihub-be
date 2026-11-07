import { getMetrics } from '@/common/observability/metrics';
import {
  Gradient2ConcurrencyLimiter,
  Gradient2Limit,
} from './gradient2-concurrency-limiter';

describe('Gradient2Limit', () => {
  it('keeps the seeded limit while the origin is app-limited', () => {
    const limit = new Gradient2Limit();

    for (let sample = 0; sample < 12; sample += 1) {
      limit.onSample(1_000, 0);
    }

    expect(limit.getLimit()).toBe(10);
    expect(limit.getRttMinMs()).toBe(1_000);
  });

  it('grows toward the documented maximum on flat RTT under load', () => {
    const limit = new Gradient2Limit();
    limit.onSample(100, 10);

    for (let sample = 0; sample < 60; sample += 1) {
      limit.onSample(100, 10);
    }

    expect(limit.getLimit()).toBe(20);
  });

  it('shrinks to the documented minimum on a 1s to 20s provider latency spike', () => {
    const limit = new Gradient2Limit();
    for (let sample = 0; sample < 12; sample += 1) {
      limit.onSample(1_000, 0);
    }

    for (let sample = 0; sample < 4; sample += 1) {
      limit.onSample(20_000, 10);
    }
    expect(limit.getLimit()).toBeLessThan(10);

    for (let sample = 0; sample < 200; sample += 1) {
      limit.onSample(20_000, 10);
    }
    expect(limit.getLimit()).toBe(2);
  });

  it('decays the baseline RTT when latency recovers after sustained load', () => {
    const limit = new Gradient2Limit();
    for (let sample = 0; sample < 12; sample += 1) {
      limit.onSample(20_000, 0);
      limit.onSample(20_000, 0);
    }

    limit.onSample(1_000, 10);
    expect(limit.getRttMinMs()).toBe(18_939);
  });
});

describe('Gradient2ConcurrencyLimiter', () => {
  it('admits up to the seeded limit and fast-fails excess per origin', () => {
    const limiter = new Gradient2ConcurrencyLimiter();

    const admitted = Array.from({ length: 10 }, () =>
      limiter.tryAcquire('https://ai-writing.test'),
    );

    expect(admitted).toEqual(Array.from({ length: 10 }, () => true));
    expect(limiter.tryAcquire('https://ai-writing.test')).toBe(false);
    expect(limiter.tryAcquire('https://ai-speaking.test')).toBe(true);
  });

  it('releases a slot, records its RTT sample, and admits again', () => {
    const limiter = new Gradient2ConcurrencyLimiter();
    for (let request = 0; request < 10; request += 1) {
      expect(limiter.tryAcquire('https://ai-writing.test')).toBe(true);
    }

    limiter.release('https://ai-writing.test', 150);

    expect(
      limiter
        .snapshot()
        .find((sample) => sample.origin === 'https://ai-writing.test'),
    ).toMatchObject({ limit: 10, inFlight: 9, rttMinMs: 150, rttAvgMs: 150 });
    expect(limiter.tryAcquire('https://ai-writing.test')).toBe(true);
  });

  it('ignores releases for an origin it never admitted', () => {
    const limiter = new Gradient2ConcurrencyLimiter();

    limiter.release('https://unknown.test', 100);

    expect(limiter.snapshot()).toEqual([]);
  });

  it('shrinks the admitted concurrency after a simulated provider latency spike', () => {
    const origin = 'https://spike.test';
    const limiter = new Gradient2ConcurrencyLimiter();

    for (let request = 0; request < 12; request += 1) {
      limiter.tryAcquire(origin);
    }
    for (let request = 0; request < 12; request += 1) {
      limiter.release(origin, 1_000);
    }
    const beforeSpike = limiter.snapshot()[0]?.limit ?? 0;

    for (let request = 0; request < 12; request += 1) {
      limiter.tryAcquire(origin);
    }
    for (let request = 0; request < 12; request += 1) {
      limiter.release(origin, 20_000);
    }
    const afterSpike = limiter.snapshot()[0]?.limit ?? 0;

    expect(afterSpike).toBeLessThan(beforeSpike);
    expect(afterSpike).toBeGreaterThanOrEqual(2);
  });

  it('records each refused admission in the limit-dropped metric', async () => {
    const limiter = new Gradient2ConcurrencyLimiter();

    for (let request = 0; request < 10; request += 1) {
      expect(limiter.tryAcquire('https://drop.test')).toBe(true);
    }
    expect(limiter.tryAcquire('https://drop.test')).toBe(false);

    expect(await getMetrics()).toContain(
      'aihub_downstream_limit_dropped_total{origin="https://drop.test"} 1',
    );
  });
});

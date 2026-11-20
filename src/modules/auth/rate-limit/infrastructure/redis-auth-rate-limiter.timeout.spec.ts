import Redis from 'ioredis';

import { RedisAuthRateLimiter } from './redis-auth-rate-limiter';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('RedisAuthRateLimiter Redis client', () => {
  // docs/operations/redis-round-trip.md: at least three times the measured p95
  // round trip, rounded up to 100 ms. A shorter timeout skips the shared sign-in
  // limit whenever the network is a little slow.
  it('gives a command at least the margin over the measured round trip', () => {
    jest.mocked(Redis).mockReturnValue({ on: jest.fn() } as unknown as Redis);

    expect(
      new RedisAuthRateLimiter('redis://limiter.test.invalid/0'),
    ).toBeInstanceOf(RedisAuthRateLimiter);

    const calls = jest.mocked(Redis).mock.calls as unknown as [
      string,
      {
        commandTimeout: number;
        connectTimeout: number;
        autoResendUnfulfilledCommands: boolean;
        lazyConnect: boolean;
      },
    ][];
    const options = calls[0]?.[1];
    expect(options?.commandTimeout).toBeGreaterThanOrEqual(400);
    expect(options?.connectTimeout).toBe(1_000);
    expect(options?.autoResendUnfulfilledCommands).toBe(false);
    expect(options?.lazyConnect).toBe(true);
  });
});

import Redis from 'ioredis';

import { RedisIdentityStore } from './redis-identity.store';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('RedisIdentityStore Redis client', () => {
  // docs/operations/redis-round-trip.md: at least three times the measured p95
  // round trip, rounded up to 100 ms. A shorter timeout skips the shared JWKS
  // cache and asks the identity provider again whenever the network is slow.
  it('gives a command at least the margin over the measured round trip', () => {
    jest.mocked(Redis).mockReturnValue({ on: jest.fn() } as unknown as Redis);

    expect(
      new RedisIdentityStore('redis://identity.test.invalid/0'),
    ).toBeInstanceOf(RedisIdentityStore);

    const calls = jest.mocked(Redis).mock.calls as unknown as [
      string,
      { commandTimeout: number },
    ][];
    const options = calls[0]?.[1];
    expect(options?.commandTimeout).toBeGreaterThanOrEqual(400);
  });
});

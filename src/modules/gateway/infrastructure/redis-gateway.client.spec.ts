import Redis from 'ioredis';

import { createRedisGatewayClient } from './redis-gateway.client';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('createRedisGatewayClient', () => {
  // docs/operations/redis-round-trip.md: at least three times the measured p95
  // round trip, rounded up to 100 ms.
  it('uses timeout margins above the measured remote Redis round trip', () => {
    const redisClient = { on: jest.fn() } as unknown as Redis;
    const redisConstructor = jest.mocked(Redis);
    redisConstructor.mockReturnValue(redisClient);

    createRedisGatewayClient('redis://redis.example');

    expect(redisConstructor).toHaveBeenCalledWith(
      'redis://redis.example',
      expect.objectContaining({
        connectTimeout: 1_000,
        commandTimeout: 400,
      }),
    );
  });
});

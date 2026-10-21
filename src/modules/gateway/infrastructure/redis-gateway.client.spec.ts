import Redis from 'ioredis';

import { createRedisGatewayClient } from './redis-gateway.client';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('createRedisGatewayClient', () => {
  it('uses timeout margins above the measured remote Redis p99 latencies', () => {
    const redisClient = { on: jest.fn() } as unknown as Redis;
    const redisConstructor = jest.mocked(Redis);
    redisConstructor.mockReturnValue(redisClient);

    createRedisGatewayClient('redis://redis.example');

    expect(redisConstructor).toHaveBeenCalledWith(
      'redis://redis.example',
      expect.objectContaining({
        connectTimeout: 1_000,
        commandTimeout: 200,
      }),
    );
  });
});

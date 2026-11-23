import { EventEmitter } from 'node:events';

import Redis from 'ioredis';

import {
  RedisGatewayClientLifecycle,
  createRedisGatewayClient,
} from './redis-gateway.client';

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
        autoResendUnfulfilledCommands: false,
      }),
    );
  });

  it('waits for ioredis ready and removes its listener after readiness', async () => {
    const redisClient = Object.assign(new EventEmitter(), {
      status: 'connecting',
    }) as unknown as Redis;
    jest.mocked(Redis).mockReturnValue(redisClient);
    const client = createRedisGatewayClient('redis://redis.example');
    if (client === undefined) throw new Error('expected a Redis client');

    const ready = client.waitUntilReady(new AbortController().signal);
    expect(redisClient.listenerCount('ready')).toBe(1);
    redisClient.emit('ready');

    await expect(ready).resolves.toBe(true);
    expect(redisClient.listenerCount('ready')).toBe(0);
  });

  it('lets shutdown abort a pending readiness wait', async () => {
    const redisClient = Object.assign(new EventEmitter(), {
      status: 'connecting',
    }) as unknown as Redis;
    jest.mocked(Redis).mockReturnValue(redisClient);
    const client = createRedisGatewayClient('redis://redis.example');
    if (client === undefined) throw new Error('expected a Redis client');
    const abort = new AbortController();

    const ready = client.waitUntilReady(abort.signal);
    abort.abort();

    await expect(ready).resolves.toBe(false);
    expect(redisClient.listenerCount('ready')).toBe(0);
  });
});

describe('RedisGatewayClientLifecycle', () => {
  it('closes the shared Redis connection once at application shutdown', async () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const lifecycle = new RedisGatewayClientLifecycle({ quit });

    await lifecycle.onApplicationShutdown();

    expect(quit).toHaveBeenCalledTimes(1);
  });
});

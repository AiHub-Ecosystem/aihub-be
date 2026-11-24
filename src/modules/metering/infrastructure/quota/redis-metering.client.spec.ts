import { EventEmitter } from 'node:events';

import Redis from 'ioredis';

import { createRedisMeteringClient } from './redis-metering.client';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

describe('createRedisMeteringClient', () => {
  it('disables queued and reconnect-replayed request mutations', () => {
    const client = new EventEmitter() as unknown as Redis;
    jest.mocked(Redis).mockReturnValue(client);

    const meteringClient = createRedisMeteringClient('redis://redis.test/0');

    expect(meteringClient).toBeDefined();
    expect(jest.mocked(Redis)).toHaveBeenCalledWith(
      'redis://redis.test/0',
      expect.objectContaining({
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 1,
      }),
    );
    expect(client.listenerCount('error')).toBe(1);
  });
});

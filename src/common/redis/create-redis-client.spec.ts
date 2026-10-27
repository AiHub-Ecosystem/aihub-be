import { createRedisClient } from './create-redis-client';

describe('createRedisClient', () => {
  it('builds a lazy-safe client with the caller timeouts and no offline queue', () => {
    const client = createRedisClient('redis://127.0.0.1:1/0', {
      commandTimeoutMs: 400,
      connectTimeoutMs: 1_000,
      autoResendUnfulfilledCommands: false,
    });

    try {
      expect(client.options.commandTimeout).toBe(400);
      expect(client.options.connectTimeout).toBe(1_000);
      expect(client.options.enableOfflineQueue).toBe(false);
      expect(client.options.maxRetriesPerRequest).toBe(1);
      expect(client.options.autoResendUnfulfilledCommands).toBe(false);
      expect(client.listenerCount('error')).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  it('leaves the connect timeout to the driver default when the caller omits it', () => {
    const client = createRedisClient('redis://127.0.0.1:1/0', {
      commandTimeoutMs: 400,
    });

    try {
      expect(client.options.connectTimeout).toBe(10_000);
    } finally {
      client.disconnect();
    }
  });
});

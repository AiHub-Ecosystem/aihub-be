import {
  SANDBOX_REDIS_KEY_PREFIX,
  createConfiguredRedisClient,
} from './redis-client.factory';

describe('createConfiguredRedisClient', () => {
  it('extracts the Sandbox namespace from the connection URL', () => {
    const client = createConfiguredRedisClient(
      'redis://sandbox-runtime:private-password@localhost:6379/1?keyPrefix=aihub-sandbox%3A',
      { lazyConnect: true, commandTimeout: 500 },
    );

    expect(client.options).toMatchObject({
      db: 1,
      username: 'sandbox-runtime',
      keyPrefix: SANDBOX_REDIS_KEY_PREFIX,
      enableReadyCheck: false,
      commandTimeout: 500,
      lazyConnect: true,
    });

    client.disconnect();
  });

  it('preserves connection URLs without an explicit namespace', () => {
    const client = createConfiguredRedisClient('redis://localhost:6379/0', {
      lazyConnect: true,
    });

    expect(client.options).toMatchObject({
      db: 0,
      keyPrefix: '',
      lazyConnect: true,
    });

    client.disconnect();
  });

  it('rejects duplicate namespace settings without echoing credentials', () => {
    const url =
      'redis://sandbox-runtime:private-password@localhost:6379/1?keyPrefix=one&keyPrefix=two';

    expect(() =>
      createConfiguredRedisClient(url, { lazyConnect: true }),
    ).toThrow('Redis URL keyPrefix is invalid');
    expect(() =>
      createConfiguredRedisClient(url, { lazyConnect: true }),
    ).not.toThrow('private-password');
  });
});

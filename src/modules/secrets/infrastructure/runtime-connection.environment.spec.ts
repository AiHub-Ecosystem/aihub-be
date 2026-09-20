import {
  RuntimeConnectionConfigurationError,
  loadRuntimeConnectionEnvironment,
} from './runtime-connection.environment';

function document(): string {
  return JSON.stringify({
    database: {
      url: 'postgresql://production',
      sandbox_url: 'postgresql://sandbox',
    },
    redis: {
      url: 'redis://production/0',
      sandbox_url: 'redis://sandbox/1',
    },
    'sandbox-assertion': {
      private_key_pem: 'private-key',
      key_id: 'sandbox-key',
    },
  });
}

describe('loadRuntimeConnectionEnvironment', () => {
  it('loads production connections and sandbox signing material', () => {
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
    };

    loadRuntimeConnectionEnvironment({
      env,
      readFile: () => document(),
    });

    expect(env.DATABASE_URL).toBe('postgresql://production');
    expect(env.REDIS_URL).toBe('redis://production/0');
    expect(env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY).toBe('private-key');
    expect(env.AIHUB_SANDBOX_ASSERTION_KID).toBe('sandbox-key');
  });

  it('selects sandbox connections for the sandbox container', () => {
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
    };

    loadRuntimeConnectionEnvironment({
      env,
      readFile: () => document(),
    });

    expect(env.DATABASE_URL).toBe('postgresql://sandbox');
    expect(env.REDIS_URL).toBe('redis://sandbox/1');
  });

  it('leaves an explicit local environment untouched without a connection file', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://local',
      REDIS_URL: 'redis://local/0',
    };

    loadRuntimeConnectionEnvironment({ env });

    expect(env).toMatchObject({
      DATABASE_URL: 'postgresql://local',
      REDIS_URL: 'redis://local/0',
    });
  });

  it('fails without exposing a secret when a required connection is missing', () => {
    const marker = 'postgresql://private-password';
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
    };

    expect(() =>
      loadRuntimeConnectionEnvironment({
        env,
        readFile: () =>
          JSON.stringify({
            database: { url: marker },
            redis: {},
          }),
      }),
    ).toThrow(RuntimeConnectionConfigurationError);

    try {
      loadRuntimeConnectionEnvironment({
        env,
        readFile: () =>
          JSON.stringify({
            database: { url: marker },
            redis: {},
          }),
      });
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });
});

import {
  RuntimeConnectionConfigurationError,
  loadRuntimeConnectionEnvironment,
} from './runtime-connection.environment';

function productionDocument(): string {
  return JSON.stringify({
    database: {
      url: 'postgresql://production',
    },
    redis: {
      url: 'redis://production/0',
    },
  });
}

function sandboxDocument(
  redisUrl = 'redis://sandbox-runtime:private-password@sandbox/1?keyPrefix=aihub-sandbox%3A',
): string {
  return JSON.stringify({
    database: {
      sandbox_url: 'postgresql://sandbox',
      sandbox_control_plane_read_url: 'postgresql://sandbox-control-read',
    },
    redis: { sandbox_url: redisUrl },
    'sandbox-assertion': {
      private_key_pem: 'private-key',
      key_id: 'sandbox-key',
    },
  });
}

describe('loadRuntimeConnectionEnvironment', () => {
  it('loads production connections without sandbox signing material', () => {
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
      AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: 'stale-key',
      AIHUB_SANDBOX_ASSERTION_KID: 'stale-id',
    };

    loadRuntimeConnectionEnvironment({
      env,
      readFile: productionDocument,
    });

    expect(env.DATABASE_URL).toBe('postgresql://production');
    expect(env.CONTROL_PLANE_READ_DATABASE_URL).toBe('postgresql://production');
    expect(env.REDIS_URL).toBe('redis://production/0');
    expect(env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY).toBeUndefined();
    expect(env.AIHUB_SANDBOX_ASSERTION_KID).toBeUndefined();
  });

  it('selects sandbox connections for the sandbox container', () => {
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
    };

    loadRuntimeConnectionEnvironment({
      env,
      readFile: () => sandboxDocument(),
    });

    expect(env.DATABASE_URL).toBe('postgresql://sandbox');
    expect(env.CONTROL_PLANE_READ_DATABASE_URL).toBe(
      'postgresql://sandbox-control-read',
    );
    expect(env.REDIS_URL).toBe(
      'redis://sandbox-runtime:private-password@sandbox/1?keyPrefix=aihub-sandbox%3A',
    );
    expect(env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY).toBe('private-key');
    expect(env.AIHUB_SANDBOX_ASSERTION_KID).toBe('sandbox-key');
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

    const load = () =>
      loadRuntimeConnectionEnvironment({
        env,
        readFile: () =>
          JSON.stringify({
            database: { url: marker },
            redis: {},
          }),
      });

    expect(load).toThrow(RuntimeConnectionConfigurationError);
    // The marker is a connection URL carrying a password; it must not reach
    // the error text.
    expect(load).not.toThrow(marker);
  });

  it('fails closed if the production document contains the Sandbox signing bundle', () => {
    const marker = 'sandbox-private-key-marker';
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
    };

    let error: unknown;
    try {
      loadRuntimeConnectionEnvironment({
        env,
        readFile: () =>
          JSON.stringify({
            database: { url: 'postgresql://production' },
            redis: { url: 'redis://production/0' },
            'sandbox-assertion': { private_key_pem: marker, key_id: 'sandbox' },
          }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RuntimeConnectionConfigurationError);
    expect((error as Error).message).not.toContain(marker);
  });

  it('rejects Production database fields in the Sandbox document', () => {
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
    };

    expect(() =>
      loadRuntimeConnectionEnvironment({
        env,
        readFile: () =>
          JSON.stringify({
            database: {
              url: 'postgresql://production',
              sandbox_url: 'postgresql://sandbox',
              sandbox_control_plane_read_url:
                'postgresql://sandbox-control-read',
            },
            redis: { sandbox_url: 'redis://sandbox/1' },
            'sandbox-assertion': {
              private_key_pem: 'private-key',
              key_id: 'sandbox-key',
            },
          }),
      }),
    ).toThrow(RuntimeConnectionConfigurationError);
  });

  it('rejects a Sandbox Redis URL without its dedicated key namespace', () => {
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
    };

    expect(() =>
      loadRuntimeConnectionEnvironment({
        env,
        readFile: () => sandboxDocument('redis://sandbox-runtime@sandbox/1'),
      }),
    ).toThrow(RuntimeConnectionConfigurationError);
  });
});

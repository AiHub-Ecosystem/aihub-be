import {
  RuntimeConnectionConfigurationError,
  loadRuntimeConnectionEnvironment,
} from './runtime-connection.environment';

function document(): string {
  return JSON.stringify({
    database: {
      url: 'postgresql://production',
      sandbox_url: 'postgresql://sandbox',
      sandbox_control_plane_read_url: 'postgresql://sandbox-control-read',
      email_send_budget_url: 'postgresql://shared-email-budget',
      pooler_url: 'postgresql://app@pooler/aihub',
      sandbox_pooler_url: 'postgresql://app@pooler/aihub_sandbox',
      control_plane_pooler_url: 'postgresql://app@pooler/aihub_control',
      sandbox_control_plane_pooler_url:
        'postgresql://app@pooler/aihub_sandbox_control',
      control_plane_read_pooler_url:
        'postgresql://app@pooler/aihub_control_read',
      sandbox_control_plane_read_pooler_url:
        'postgresql://app@pooler/aihub_sandbox_control_read',
      email_send_budget_pooler_url:
        'postgresql://app@pooler/aihub_email_budget',
      sandbox_email_send_budget_pooler_url:
        'postgresql://app@pooler/aihub_sandbox_email_budget',
    },
    redis: {
      url: 'redis://production/0',
      sandbox_url: 'redis://sandbox/1',
      email_send_rate_url: 'redis://shared/2',
    },
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
      readFile: () => document(),
    });

    expect(env.DATABASE_URL).toBe('postgresql://production');
    expect(env.CONTROL_PLANE_READ_DATABASE_URL).toBe('postgresql://production');
    expect(env.AIHUB_EMAIL_DAILY_BUDGET_DATABASE_URL).toBe(
      'postgresql://shared-email-budget',
    );
    expect(env.REDIS_URL).toBe('redis://production/0');
    expect(env.AIHUB_EMAIL_SEND_RATE_REDIS_URL).toBe('redis://shared/2');
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
      readFile: () => document(),
    });

    expect(env.DATABASE_URL).toBe('postgresql://sandbox');
    expect(env.CONTROL_PLANE_READ_DATABASE_URL).toBe(
      'postgresql://sandbox-control-read',
    );
    expect(env.AIHUB_EMAIL_DAILY_BUDGET_DATABASE_URL).toBe(
      'postgresql://shared-email-budget',
    );
    expect(env.REDIS_URL).toBe('redis://sandbox/1');
    expect(env.AIHUB_EMAIL_SEND_RATE_REDIS_URL).toBe('redis://shared/2');
    expect(env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY).toBe('private-key');
    expect(env.AIHUB_SANDBOX_ASSERTION_KID).toBe('sandbox-key');
  });

  it('uses Vault-provided PgBouncer URLs for runtime and direct URLs for operators', () => {
    const runtimeEnv: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_DATABASE_POOLER_ENABLED: 'true',
    };
    loadRuntimeConnectionEnvironment({
      env: runtimeEnv,
      readFile: () => document(),
    });

    expect(runtimeEnv).toMatchObject({
      DATABASE_URL: 'postgresql://app@pooler/aihub',
      CONTROL_PLANE_DATABASE_URL: 'postgresql://app@pooler/aihub_control',
      CONTROL_PLANE_READ_DATABASE_URL:
        'postgresql://app@pooler/aihub_control_read',
      AIHUB_EMAIL_DAILY_BUDGET_DATABASE_URL:
        'postgresql://app@pooler/aihub_email_budget',
    });

    const operatorEnv: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_DATABASE_POOLER_ENABLED: 'true',
    };
    loadRuntimeConnectionEnvironment({
      env: operatorEnv,
      target: 'operator',
      readFile: () => document(),
    });

    expect(operatorEnv.DATABASE_URL).toBe('postgresql://production');
    expect(operatorEnv.CONTROL_PLANE_DATABASE_URL).toBe(
      'postgresql://production',
    );
    expect(operatorEnv.CONTROL_PLANE_READ_DATABASE_URL).toBe(
      'postgresql://production',
    );
    expect(operatorEnv.AIHUB_EMAIL_DAILY_BUDGET_DATABASE_URL).toBe(
      'postgresql://shared-email-budget',
    );
  });

  it('fails closed when PgBouncer is enabled but a role URL is missing', () => {
    const env: NodeJS.ProcessEnv = {
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connections.json',
      AIHUB_DATABASE_POOLER_ENABLED: 'true',
    };
    const missingPoolerUrls = JSON.stringify({
      database: {
        url: 'postgresql://production',
        sandbox_url: 'postgresql://sandbox',
        sandbox_control_plane_read_url: 'postgresql://sandbox-control-read',
        email_send_budget_url: 'postgresql://shared-email-budget',
      },
      redis: {
        url: 'redis://production/0',
        sandbox_url: 'redis://sandbox/1',
        email_send_rate_url: 'redis://shared/2',
      },
    });

    expect(() =>
      loadRuntimeConnectionEnvironment({
        env,
        readFile: () => missingPoolerUrls,
      }),
    ).toThrow('PgBouncer runtime URL');
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
});

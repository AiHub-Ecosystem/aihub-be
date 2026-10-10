import {
  RuntimeConfigurationError,
  appConfig,
  loadRuntimeConfiguration,
  runtimeEnvironmentMetadata,
} from './runtime-configuration';

describe('runtime configuration', () => {
  it('applies declared defaults and parses scalar values', () => {
    const config = loadRuntimeConfiguration({
      NODE_ENV: 'test',
      AIHUB_RUNTIME_SECRET_SOURCE: 'agent-file',
      AIHUB_RUNTIME_SECRETS_FILE: 'runtime-secrets.json',
      AIHUB_AUTH_MFA_SECRETS_FILE: 'auth-mfa-secrets.json',
      AIHUB_USER_ACCESS_ISSUER: 'https://api.test.invalid',
      PORT: '4312',
      AIHUB_ALLOW_UNAUTHENTICATED_DEV: 'true',
    });

    expect(config.PORT).toBe(4312);
    expect(config.AIHUB_ALLOW_UNAUTHENTICATED_DEV).toBe(true);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.SEAWEEDFS_ENDPOINT_URL).toBe('https://s3.wispace.app');
    expect(config.SEAWEEDFS_REGION).toBe('us-east-1');
  });

  it('aggregates missing and invalid variable names without their values', () => {
    let caught: unknown;
    try {
      loadRuntimeConfiguration({
        NODE_ENV: 'production',
        AIHUB_RUNTIME_SECRET_SOURCE: 'env',
        AIHUB_USER_ACCESS_ISSUER: 'not a URL',
        PORT: 'not-a-port',
        LOG_LEVEL: 'super-verbose',
        RESEND_API_KEY: 'secret-that-must-not-appear',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConfigurationError);
    const error = caught as RuntimeConfigurationError;
    expect(error.variableNames).toEqual(
      expect.arrayContaining([
        'PORT',
        'LOG_LEVEL',
        'AIHUB_USER_ACCESS_ISSUER',
        'AIHUB_PRODUCTION_HOST',
        'DOWNSTREAM_AI_WRITING_URL',
        'DOWNSTREAM_AI_SPEAKING_URL',
        'RESEND_FROM',
        'CUSTOMER_WEB_BASE_URL',
        'DOWNSTREAM_AI_WRITING_TOKEN',
      ]),
    );
    expect(error.message).not.toContain('secret-that-must-not-appear');
  });

  it('aggregates unsafe host bindings by variable name', () => {
    let caught: unknown;
    try {
      loadRuntimeConfiguration({
        NODE_ENV: 'production',
        AIHUB_RUNTIME_SECRET_SOURCE: 'agent-file',
        AIHUB_RUNTIME_SECRETS_FILE: 'runtime-secrets.json',
        AIHUB_USER_ACCESS_ISSUER: 'https://api.test.invalid',
        DATABASE_URL: 'postgres://user:password@db.test.invalid/aihub',
        REDIS_URL: 'redis://user:password@redis.test.invalid/0',
        DOWNSTREAM_AI_WRITING_URL: 'https://writing.test.invalid',
        DOWNSTREAM_AI_SPEAKING_URL: 'https://speaking.test.invalid',
        RESEND_FROM: 'no-reply@test.invalid',
        CUSTOMER_WEB_BASE_URL: 'https://customer.test.invalid',
        AIHUB_ALLOW_UNAUTHENTICATED_DEV: 'true',
        AIHUB_PRODUCTION_HOST: 'api.aihub.example.com',
        AIHUB_STAGING_HOST: 'API.AIHUB.EXAMPLE.COM.',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConfigurationError);
    expect((caught as RuntimeConfigurationError).variableNames).toEqual(
      expect.arrayContaining([
        'AIHUB_PRODUCTION_HOST',
        'AIHUB_STAGING_HOST',
        'AIHUB_ALLOW_UNAUTHENTICATED_DEV',
      ]),
    );
    expect((caught as Error).message).not.toContain('test.invalid');
  });

  it('records the type, default, required mode, and secret status in one schema', () => {
    expect(runtimeEnvironmentMetadata.PORT).toMatchObject({
      type: 'number',
      defaultValue: 3000,
    });
    expect(runtimeEnvironmentMetadata.SEAWEEDFS_ACCESS_KEY_ID?.secret).toBe(
      true,
    );
    expect(
      runtimeEnvironmentMetadata.DOWNSTREAM_AI_WRITING_URL?.requiredIn,
    ).toEqual(['staging', 'production']);
  });

  it('requires the BFF environment secret only for the environment secret source', () => {
    const secret = runtimeEnvironmentMetadata.AIHUB_WEB_SESSION_CLIENT_SECRET;

    expect(secret).toMatchObject({
      type: 'string',
      secret: true,
      requiredIn: ['staging', 'production'],
      requiredWhenSecretSource: true,
    });

    const reportedIn = (mode: string, source = 'env'): readonly string[] => {
      try {
        loadRuntimeConfiguration({
          NODE_ENV: mode,
          AIHUB_RUNTIME_SECRET_SOURCE: source,
        });
        return [];
      } catch (error) {
        return (error as RuntimeConfigurationError).variableNames;
      }
    };

    // Only this variable's own absence is asserted: an instance missing other
    // required settings fails for its own reasons.
    expect(reportedIn('production')).toContain(
      'AIHUB_WEB_SESSION_CLIENT_SECRET',
    );
    expect(reportedIn('staging')).toContain('AIHUB_WEB_SESSION_CLIENT_SECRET');
    for (const mode of ['production', 'staging']) {
      expect(reportedIn(mode, 'agent-file')).not.toContain(
        'AIHUB_WEB_SESSION_CLIENT_SECRET',
      );
    }
    expect(reportedIn('development')).not.toContain(
      'AIHUB_WEB_SESSION_CLIENT_SECRET',
    );
    expect(reportedIn('test')).not.toContain('AIHUB_WEB_SESSION_CLIENT_SECRET');
  });

  it.each(['production', 'staging'] as const)(
    'boots %s configuration without an environment copy of the Vault BFF secret',
    (mode) => {
      const config = loadRuntimeConfiguration({
        NODE_ENV: mode,
        AIHUB_RUNTIME_SECRET_SOURCE: 'agent-file',
        AIHUB_RUNTIME_SECRETS_FILE: 'runtime-secrets.json',
        AIHUB_AUTH_MFA_SECRETS_FILE: 'auth-mfa-secrets.json',
        AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: 'connection-secrets.json',
        DATABASE_URL: 'postgres://fake:fake@db.test.invalid/aihub',
        REDIS_URL: 'redis://redis.test.invalid/0',
        AIHUB_USER_ACCESS_ISSUER: 'https://api.test.invalid',
        AIHUB_PRODUCTION_HOST: 'api.test.invalid',
        DOWNSTREAM_AI_WRITING_URL: 'https://writing.test.invalid',
        DOWNSTREAM_AI_SPEAKING_URL: 'https://speaking.test.invalid',
        RESEND_FROM: 'no-reply@test.invalid',
        CUSTOMER_WEB_BASE_URL: 'https://customer.test.invalid',
      });
      expect(config.AIHUB_WEB_SESSION_CLIENT_SECRET).toBeUndefined();
    },
  );

  it('keeps secret values out of the Nest application config provider', () => {
    const configuration = appConfig();

    expect(configuration).not.toHaveProperty('DATABASE_URL');
    expect(configuration).not.toHaveProperty('DOWNSTREAM_AI_WRITING_TOKEN');
    expect(configuration).not.toHaveProperty(
      'AIHUB_USER_ACCESS_JWT_PRIVATE_KEY',
    );
    expect(configuration).not.toHaveProperty('AIHUB_WEB_SESSION_CLIENT_SECRET');
  });
});

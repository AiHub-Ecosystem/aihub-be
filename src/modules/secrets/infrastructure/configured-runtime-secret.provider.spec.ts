import {
  ConfiguredRuntimeSecretProvider,
  RuntimeSecretConfigurationError,
  type RuntimeSecretProviderOptions,
} from './configured-runtime-secret.provider';

const speakingClient = 'speaking-client';
const speakingSecret = 'speaking-secret';
const writingToken = 'writing-token';
const resendApiKey = 'resend-api-key';

function options(
  overrides: Partial<RuntimeSecretProviderOptions> = {},
): RuntimeSecretProviderOptions {
  return {
    nodeEnv: 'development',
    source: 'env',
    secretsFile: undefined,
    values: {
      DOWNSTREAM_AI_SPEAKING_CLIENT_ID: speakingClient,
      DOWNSTREAM_AI_SPEAKING_SECRET_KEY: speakingSecret,
      DOWNSTREAM_AI_WRITING_TOKEN: writingToken,
      RESEND_API_KEY: resendApiKey,
    },
    ...overrides,
  };
}

describe('ConfiguredRuntimeSecretProvider', () => {
  it('loads typed runtime secrets from the explicit local source', () => {
    const provider = new ConfiguredRuntimeSecretProvider(options());

    expect(provider.getSnapshot()).toEqual({
      aiSpeaking: {
        clientId: speakingClient,
        secretKey: speakingSecret,
      },
      aiWriting: { token: writingToken },
      resend: { apiKey: resendApiKey },
    });
  });

  it('loads an Agent-rendered JSON snapshot and keeps it stable after startup', () => {
    let fileContents = JSON.stringify({
      'ai-speaking': {
        client_id: speakingClient,
        secret_key: speakingSecret,
      },
      'ai-writing': { token: writingToken },
      resend: { api_key: resendApiKey },
      seaweedfs: {
        access_key_id: 'storage-access',
        secret_access_key: 'storage-secret',
      },
    });
    const provider = new ConfiguredRuntimeSecretProvider(
      options({
        source: 'agent-file',
        secretsFile: 'runtime-secrets.json',
        readFile: () => fileContents,
      }),
    );
    const first = provider.getSnapshot();
    fileContents = '{"ai-writing":{"token":"changed"}}';

    expect(first).toEqual({
      aiSpeaking: {
        clientId: speakingClient,
        secretKey: speakingSecret,
      },
      aiWriting: { token: writingToken },
      resend: { apiKey: resendApiKey },
      seaweedfs: {
        accessKeyId: 'storage-access',
        secretAccessKey: 'storage-secret',
      },
    });
    expect(provider.getSnapshot()).toBe(first);
  });

  it('requires an explicit env source and rejects it for production', () => {
    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({ nodeEnv: 'test', source: undefined }),
        ),
    ).toThrow(
      'AIHUB_RUNTIME_SECRET_SOURCE or AIHUB_RUNTIME_SECRETS_FILE is required',
    );

    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({ nodeEnv: 'production', source: 'env' }),
        ),
    ).toThrow(
      'environment source is allowed only for local development and tests',
    );
  });

  it('allows production env secrets only with an explicit opt-in', () => {
    const provider = new ConfiguredRuntimeSecretProvider(
      options({
        nodeEnv: 'production',
        source: 'env',
        allowProductionEnvSecrets: true,
      }),
    );

    expect(provider.getSnapshot()).toEqual({
      aiSpeaking: {
        clientId: speakingClient,
        secretKey: speakingSecret,
      },
      aiWriting: { token: writingToken },
      resend: { apiKey: resendApiKey },
    });
  });

  it('does not extend the production opt-in to staging', () => {
    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            nodeEnv: 'staging',
            source: 'env',
            allowProductionEnvSecrets: true,
          }),
        ),
    ).toThrow(
      'environment source is allowed only for local development and tests',
    );
  });

  it('rejects unexpected Agent-file root and bundle fields', () => {
    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            source: 'agent-file',
            secretsFile: 'runtime-secrets.json',
            readFile: () =>
              JSON.stringify({
                'ai-speaking': {
                  client_id: speakingClient,
                  secret_key: speakingSecret,
                  leaked: 'unexpected',
                },
                'ai-writing': { token: writingToken },
                resend: { api_key: resendApiKey },
              }),
          }),
        ),
    ).toThrow('contains unexpected fields');

    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            source: 'agent-file',
            secretsFile: 'runtime-secrets.json',
            readFile: () =>
              JSON.stringify({
                'ai-speaking': {
                  client_id: speakingClient,
                  secret_key: speakingSecret,
                },
                'ai-writing': { token: writingToken },
                resend: { api_key: resendApiKey },
                extra: { value: 'unexpected' },
              }),
          }),
        ),
    ).toThrow('contains unexpected fields');
  });

  it('rejects a missing required credential without exposing its value', () => {
    const marker = 'super-private-speaking-secret';

    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            values: {
              DOWNSTREAM_AI_SPEAKING_CLIENT_ID: speakingClient,
              DOWNSTREAM_AI_SPEAKING_SECRET_KEY: marker,
            },
          }),
        ),
    ).toThrow(RuntimeSecretConfigurationError);

    try {
      new ConfiguredRuntimeSecretProvider(
        options({
          values: {
            DOWNSTREAM_AI_SPEAKING_CLIENT_ID: speakingClient,
            DOWNSTREAM_AI_SPEAKING_SECRET_KEY: marker,
          },
        }),
      );
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it('does not invent placeholder credentials in test mode', () => {
    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            nodeEnv: 'test',
            values: {},
          }),
        ),
    ).toThrow('required runtime secret is missing');
  });

  it('rejects malformed Agent-rendered data without exposing raw JSON', () => {
    const marker = 'private-json-secret';

    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            source: 'agent-file',
            secretsFile: 'runtime-secrets.json',
            readFile: () => `{"ai-speaking":{"secret_key":"${marker}"}`,
          }),
        ),
    ).toThrow(RuntimeSecretConfigurationError);

    try {
      new ConfiguredRuntimeSecretProvider(
        options({
          source: 'agent-file',
          secretsFile: 'runtime-secrets.json',
          readFile: () => `{"ai-speaking":{"secret_key":"${marker}"}`,
        }),
      );
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it('fails closed when the Agent-rendered file is unavailable', () => {
    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            source: 'agent-file',
            secretsFile: 'runtime-secrets.json',
            readFile: () => {
              throw new Error('private file-system detail');
            },
          }),
        ),
    ).toThrow('runtime secret file cannot be read');
  });

  it('rejects a partial optional SeaweedFS bundle', () => {
    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            values: {
              DOWNSTREAM_AI_SPEAKING_CLIENT_ID: speakingClient,
              DOWNSTREAM_AI_SPEAKING_SECRET_KEY: speakingSecret,
              DOWNSTREAM_AI_WRITING_TOKEN: writingToken,
              RESEND_API_KEY: resendApiKey,
              SEAWEEDFS_ACCESS_KEY_ID: 'storage-access',
            },
          }),
        ),
    ).toThrow('SeaweedFS runtime secret bundle is incomplete');
  });
});

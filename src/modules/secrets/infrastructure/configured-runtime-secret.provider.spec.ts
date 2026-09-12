import {
  ConfiguredRuntimeSecretProvider,
  RuntimeSecretConfigurationError,
  type RuntimeSecretProviderOptions,
} from './configured-runtime-secret.provider';

const speakingClient = 'speaking-client';
const speakingSecret = 'speaking-secret';
const writingToken = 'writing-token';

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
    });
  });

  it('loads an Agent-rendered JSON snapshot and keeps it stable after startup', () => {
    let fileContents = JSON.stringify({
      'ai-speaking': {
        client_id: speakingClient,
        secret_key: speakingSecret,
      },
      'ai-writing': { token: writingToken },
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
      seaweedfs: {
        accessKeyId: 'storage-access',
        secretAccessKey: 'storage-secret',
      },
    });
    expect(provider.getSnapshot()).toBe(first);
  });

  it('allows the implicit env source only for tests, never for production', () => {
    expect(
      new ConfiguredRuntimeSecretProvider(
        options({ nodeEnv: 'test', source: undefined }),
      ).getSnapshot().aiWriting.token,
    ).toBe(writingToken);

    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({ nodeEnv: 'production', source: 'env' }),
        ),
    ).toThrow(
      'environment source is allowed only for local development and tests',
    );
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

  it('rejects a partial optional SeaweedFS bundle', () => {
    expect(
      () =>
        new ConfiguredRuntimeSecretProvider(
          options({
            values: {
              DOWNSTREAM_AI_SPEAKING_CLIENT_ID: speakingClient,
              DOWNSTREAM_AI_SPEAKING_SECRET_KEY: speakingSecret,
              DOWNSTREAM_AI_WRITING_TOKEN: writingToken,
              SEAWEEDFS_ACCESS_KEY_ID: 'storage-access',
            },
          }),
        ),
    ).toThrow('SeaweedFS runtime secret bundle is incomplete');
  });
});

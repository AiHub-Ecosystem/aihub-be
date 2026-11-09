import {
  RuntimeConfigurationError,
  getRuntimeConfiguration,
  getRuntimeSecretEnvironment,
} from '@/config/runtime-configuration';
import { useTestRuntimeConfiguration } from './test-runtime-configuration';

describe('useTestRuntimeConfiguration (#1551)', () => {
  // Each test starts from the Jest setup baseline, so none depends on the
  // snapshot an earlier one installed.
  beforeEach(() => {
    useTestRuntimeConfiguration();
  });

  it('installs the explicit values without touching process.env', () => {
    const before = { ...process.env };

    useTestRuntimeConfiguration({
      DOWNSTREAM_AI_WRITING_URL: 'https://ai-writing.explicit.test',
    });

    expect(getRuntimeConfiguration().DOWNSTREAM_AI_WRITING_URL).toBe(
      'https://ai-writing.explicit.test',
    );
    expect(process.env).toEqual(before);
  });

  it('replaces a snapshot an earlier consumer already initialized', () => {
    expect(getRuntimeConfiguration().AIHUB_ALLOW_UNAUTHENTICATED_DEV).toBe(
      false,
    );

    useTestRuntimeConfiguration({ AIHUB_ALLOW_UNAUTHENTICATED_DEV: 'true' });

    expect(getRuntimeConfiguration().AIHUB_ALLOW_UNAUTHENTICATED_DEV).toBe(
      true,
    );
  });

  it('drops a variable overridden with undefined', () => {
    useTestRuntimeConfiguration({ AIHUB_PRODUCTION_HOST: 'api.aihub.test' });
    expect(getRuntimeConfiguration().AIHUB_PRODUCTION_HOST).toBe(
      'api.aihub.test',
    );

    useTestRuntimeConfiguration({ AIHUB_PRODUCTION_HOST: undefined });

    expect(getRuntimeConfiguration().AIHUB_PRODUCTION_HOST).toBeUndefined();
  });

  it('keeps the secrets the Jest setup provides', () => {
    useTestRuntimeConfiguration({});

    expect(
      getRuntimeSecretEnvironment()['DOWNSTREAM_AI_WRITING_TOKEN'],
    ).toEqual(expect.any(String));
  });

  it('runs the override through the runtime configuration validation', () => {
    expect(() =>
      useTestRuntimeConfiguration({ DOWNSTREAM_AI_WRITING_URL: 'not a url' }),
    ).toThrow(RuntimeConfigurationError);
  });
});

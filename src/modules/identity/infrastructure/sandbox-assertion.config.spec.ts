import { readSandboxAssertionConfig } from './sandbox-assertion.config';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n';

function env(
  overrides: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return {
    AIHUB_SANDBOX_ORG_IDS: 'org_sandbox',
    AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: PEM,
    AIHUB_SANDBOX_ASSERTION_KID: 'sandbox-2026-09',
    ...overrides,
  };
}

describe('readSandboxAssertionConfig', () => {
  it('reads a complete configuration', () => {
    expect(readSandboxAssertionConfig(env({}))).toEqual({
      organizationIds: ['org_sandbox'],
      // Surrounding whitespace is trimmed; `importPKCS8` does not need the
      // trailing newline a PEM file usually carries.
      privateKeyPem: PEM.trim(),
      keyId: 'sandbox-2026-09',
      algorithm: 'RS256',
    });
  });

  it('accepts several organizations', () => {
    const config = readSandboxAssertionConfig(
      env({ AIHUB_SANDBOX_ORG_IDS: 'org_a, org_b ,, org_c' }),
    );

    expect(config?.organizationIds).toEqual(['org_a', 'org_b', 'org_c']);
  });

  it('restores line breaks escaped by the environment', () => {
    const config = readSandboxAssertionConfig(
      env({
        AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY:
          '-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----',
      }),
    );

    expect(config?.privateKeyPem).toBe(
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
    );
  });

  it('honours an explicit supported algorithm', () => {
    const config = readSandboxAssertionConfig(
      env({ AIHUB_SANDBOX_ASSERTION_ALG: 'ES256' }),
    );

    expect(config?.algorithm).toBe('ES256');
  });

  it.each([
    ['organizations', 'AIHUB_SANDBOX_ORG_IDS'],
    ['private key', 'AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY'],
    ['key id', 'AIHUB_SANDBOX_ASSERTION_KID'],
  ])('treats a missing %s as no sandbox at all', (_label, variable) => {
    expect(
      readSandboxAssertionConfig(env({ [variable]: undefined })),
    ).toBeUndefined();
  });

  it('treats a blank value the same as a missing one', () => {
    expect(
      readSandboxAssertionConfig(env({ AIHUB_SANDBOX_ASSERTION_KID: '   ' })),
    ).toBeUndefined();
  });

  // Falling back to the default would leave the typo signing tokens the
  // verifier cannot accept, with nothing at the failure site to explain it.
  it('refuses an unrecognised algorithm rather than defaulting', () => {
    expect(
      readSandboxAssertionConfig(env({ AIHUB_SANDBOX_ASSERTION_ALG: 'HS256' })),
    ).toBeUndefined();
  });

  it('returns nothing when the environment is empty', () => {
    expect(readSandboxAssertionConfig({})).toBeUndefined();
  });
});

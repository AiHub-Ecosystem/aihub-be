import {
  readSandboxOrganizationIds,
  readSandboxSigningMaterial,
} from './sandbox-assertion.config';

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

describe('readSandboxSigningMaterial', () => {
  it('reads a complete key', () => {
    expect(readSandboxSigningMaterial(env({}))).toEqual({
      // Surrounding whitespace is trimmed; `importPKCS8` does not need the
      // trailing newline a PEM file usually carries.
      privateKeyPem: PEM.trim(),
      keyId: 'sandbox-2026-09',
      algorithm: 'RS256',
    });
  });

  it('restores line breaks escaped by the environment', () => {
    const material = readSandboxSigningMaterial(
      env({
        AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY:
          '-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----',
      }),
    );

    expect(material?.privateKeyPem).toBe(
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
    );
  });

  it.each([
    ['private key', 'AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY'],
    ['key id', 'AIHUB_SANDBOX_ASSERTION_KID'],
  ])('treats a missing %s as no key at all', (_label, variable) => {
    expect(
      readSandboxSigningMaterial(env({ [variable]: undefined })),
    ).toBeUndefined();
  });

  it('treats a blank value the same as a missing one', () => {
    expect(
      readSandboxSigningMaterial(env({ AIHUB_SANDBOX_ASSERTION_KID: '   ' })),
    ).toBeUndefined();
  });

  it('returns nothing when the environment is empty', () => {
    expect(readSandboxSigningMaterial({})).toBeUndefined();
  });
});

describe('readSandboxOrganizationIds', () => {
  it('reads one organization', () => {
    expect(readSandboxOrganizationIds(env({}))).toEqual(['org_sandbox']);
  });

  it('accepts several, ignoring spacing and empty entries', () => {
    expect(
      readSandboxOrganizationIds(env({ AIHUB_SANDBOX_ORG_IDS: 'a, b ,, c' })),
    ).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['only separators', ',,,'],
  ])('reads %s as an empty allowlist', (_label, value) => {
    expect(
      readSandboxOrganizationIds(env({ AIHUB_SANDBOX_ORG_IDS: value })),
    ).toEqual([]);
  });
});

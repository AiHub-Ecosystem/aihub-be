import { loadRuntimeConfiguration } from '@/config/runtime-configuration';
import {
  readSandboxOrganizationIds,
  readSandboxSigningMaterial,
} from './sandbox-assertion.config';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n';

function configuration(
  overrides: Readonly<Record<string, string | undefined>>,
): {
  readonly publicConfig: { readonly AIHUB_SANDBOX_ORG_IDS: string | undefined };
  readonly connection: {
    readonly sandboxAssertionPrivateKey: string | undefined;
    readonly sandboxAssertionKeyId: string | undefined;
  };
} {
  const loaded = loadRuntimeConfiguration({
    NODE_ENV: 'test',
    AIHUB_RUNTIME_SECRET_SOURCE: 'agent-file',
    AIHUB_RUNTIME_SECRETS_FILE: 'runtime-secrets.json',
    AIHUB_USER_ACCESS_ISSUER: 'https://api.test.invalid',
    AIHUB_SANDBOX_ORG_IDS: 'org_sandbox',
    AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: PEM,
    AIHUB_SANDBOX_ASSERTION_KID: 'sandbox-2026-09',
    ...overrides,
  });
  return {
    publicConfig: { AIHUB_SANDBOX_ORG_IDS: loaded.AIHUB_SANDBOX_ORG_IDS },
    connection: {
      sandboxAssertionPrivateKey: loaded.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY,
      sandboxAssertionKeyId: loaded.AIHUB_SANDBOX_ASSERTION_KID,
    },
  };
}

describe('readSandboxSigningMaterial', () => {
  it('reads a complete key', () => {
    expect(readSandboxSigningMaterial(configuration({}).connection)).toEqual({
      // Surrounding whitespace is trimmed; `importPKCS8` does not need the
      // trailing newline a PEM file usually carries.
      privateKeyPem: PEM.trim(),
      keyId: 'sandbox-2026-09',
      algorithm: 'RS256',
    });
  });

  it('restores line breaks escaped by the environment', () => {
    const material = readSandboxSigningMaterial(
      configuration({
        AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY:
          '-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----',
      }).connection,
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
      readSandboxSigningMaterial(
        configuration({ [variable]: undefined }).connection,
      ),
    ).toBeUndefined();
  });

  it('treats a blank value the same as a missing one', () => {
    expect(
      readSandboxSigningMaterial(
        configuration({ AIHUB_SANDBOX_ASSERTION_KID: '   ' }).connection,
      ),
    ).toBeUndefined();
  });

  it('returns nothing when the environment is empty', () => {
    expect(
      readSandboxSigningMaterial(
        configuration({
          AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: undefined,
          AIHUB_SANDBOX_ASSERTION_KID: undefined,
        }).connection,
      ),
    ).toBeUndefined();
  });
});

describe('readSandboxOrganizationIds', () => {
  it('reads one organization', () => {
    expect(readSandboxOrganizationIds(configuration({}).publicConfig)).toEqual([
      'org_sandbox',
    ]);
  });

  it('accepts several, ignoring spacing and empty entries', () => {
    expect(
      readSandboxOrganizationIds(
        configuration({ AIHUB_SANDBOX_ORG_IDS: 'a, b ,, c' }).publicConfig,
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['unset', undefined],
    ['blank', '   '],
    ['only separators', ',,,'],
  ])('reads %s as an empty allowlist', (_label, value) => {
    expect(
      readSandboxOrganizationIds(
        configuration({ AIHUB_SANDBOX_ORG_IDS: value }).publicConfig,
      ),
    ).toEqual([]);
  });
});

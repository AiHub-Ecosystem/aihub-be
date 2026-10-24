import { generateKeyPairSync } from 'node:crypto';

import { loadRuntimeConfiguration } from '@/config/runtime-configuration';
import {
  readSandboxOrganizationIds,
  readSandboxSigningMaterial,
} from './sandbox-assertion.config';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const PEM = privateKey;

const SHORT_KEY_PEM = generateKeyPairSync('rsa', { modulusLength: 1024 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const EC_KEY_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

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
    AIHUB_AUTH_MFA_SECRETS_FILE: 'auth-mfa-secrets.json',
    AIHUB_USER_ACCESS_ISSUER: 'https://api.test.invalid',
    AIHUB_TRUSTED_PROXY_IP: '127.0.0.1',
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
        AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: PEM.trim().replace(/\n/g, '\\n'),
      }).connection,
    );

    expect(material?.privateKeyPem).toBe(PEM.trim());
  });

  it('refuses an RSA key below the 2048-bit modulus floor, naming the variable', () => {
    expect(() =>
      readSandboxSigningMaterial(
        configuration({
          AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: SHORT_KEY_PEM,
        }).connection,
      ),
    ).toThrow('AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY');
  });

  it('refuses a key that is not RSA, naming the variable', () => {
    expect(() =>
      readSandboxSigningMaterial(
        configuration({
          AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: EC_KEY_PEM,
        }).connection,
      ),
    ).toThrow('AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY');
  });

  it('refuses a value that is not a parseable private key, naming the variable', () => {
    expect(() =>
      readSandboxSigningMaterial(
        configuration({
          AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: 'not a private key at all',
        }).connection,
      ),
    ).toThrow('AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY');
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

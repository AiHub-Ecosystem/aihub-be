import {
  API_KEY_PREFIX,
  apiKeyDisplayPrefix,
  apiKeyPrefixForEnvironment,
  generateApiKey,
  hashApiKey,
  isApiKeyFormat,
  isGradingScope,
  isKeyEnvironment,
  rotatedKeyEnvironments,
} from './api-key';

const SECRET = 'A'.repeat(43);

describe('API key material', () => {
  it('binds a new key to the display prefix of the environment it is for', () => {
    expect(generateApiKey('ak_1', 'sandbox').raw).toMatch(
      /^aihub_sandbox_[A-Za-z0-9]{43}$/,
    );
    expect(generateApiKey('ak_1', 'production').raw).toMatch(
      /^aihub_prod_[A-Za-z0-9]{43}$/,
    );
  });

  it('recognises the legacy and both environment prefixes and nothing else', () => {
    expect(isApiKeyFormat(`${API_KEY_PREFIX}${SECRET}`)).toBe(true);
    expect(isApiKeyFormat(`aihub_sandbox_${SECRET}`)).toBe(true);
    expect(isApiKeyFormat(`aihub_prod_${SECRET}`)).toBe(true);

    expect(isApiKeyFormat(`aihub_prod_${'A'.repeat(42)}`)).toBe(false);
    expect(isApiKeyFormat(`aihub_sandbox_${'!'.repeat(43)}`)).toBe(false);
    expect(isApiKeyFormat(`aihub_stg_${SECRET}`)).toBe(false);
    expect(isApiKeyFormat(`${API_KEY_PREFIX}${SECRET}x`)).toBe(false);
  });

  it('keeps the shared prefix for environments that name none of their own', () => {
    expect(apiKeyPrefixForEnvironment('sandbox')).toBe('aihub_sandbox_');
    expect(apiKeyPrefixForEnvironment('production')).toBe('aihub_prod_');
    expect(apiKeyPrefixForEnvironment('staging')).toBe(API_KEY_PREFIX);
  });

  it('displays six key characters beneath whichever prefix is carried', () => {
    expect(apiKeyDisplayPrefix(`aihub_sandbox_${SECRET}`)).toBe(
      'aihub_sandbox_AAAAAA',
    );
    expect(apiKeyDisplayPrefix(`aihub_prod_${SECRET}`)).toBe(
      'aihub_prod_AAAAAA',
    );
    expect(apiKeyDisplayPrefix(`${API_KEY_PREFIX}${SECRET}`)).toBe(
      'aihub_sk_AAAAAA',
    );
  });

  it('keeps the shared prefix for an environment that has none of its own', () => {
    const generated = generateApiKey('ak_1', 'development');

    expect(generated.raw).toMatch(/^aihub_sk_[A-Za-z0-9]{43}$/);
    expect(isApiKeyFormat(generated.raw)).toBe(true);
  });

  it.each(['development', 'toString', '__proto__', ''])(
    'does not take %s for an issuable environment',
    (value) => {
      expect(isKeyEnvironment(value)).toBe(false);
    },
  );

  it('narrows a rotated key to its first stored environment', () => {
    expect(rotatedKeyEnvironments(['production', 'sandbox'])).toEqual([
      'production',
    ]);
    expect(rotatedKeyEnvironments(['sandbox'])).toEqual(['sandbox']);
    expect(rotatedKeyEnvironments([])).toEqual([]);
  });

  it('names exactly the Writing and Speaking grading scopes', () => {
    expect(isGradingScope('writing.grade')).toBe(true);
    expect(isGradingScope('speaking.grade')).toBe(true);
    expect(isGradingScope('writing.read')).toBe(false);
  });

  it('stores a one-way hash rather than any recoverable part of the credential', () => {
    const generated = generateApiKey('ak_1', 'production');

    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.hash).toBe(hashApiKey(generated.raw));
    expect(generated.hash).not.toContain(generated.raw);
  });

  it('draws fresh key material on every call', () => {
    const secrets = new Set(
      Array.from({ length: 64 }, () => generateApiKey('ak_1', 'sandbox').raw),
    );

    expect(secrets.size).toBe(64);
  });
});

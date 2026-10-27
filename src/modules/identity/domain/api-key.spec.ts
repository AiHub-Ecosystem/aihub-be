import {
  API_KEY_PREFIX,
  apiKeyDisplayPrefix,
  apiKeyPrefixForEnvironment,
  apiKeyStatus,
  entitlementOfScope,
  isApiKeyFormat,
  isGradingScope,
  isKeyEnvironment,
  rotatedKeyEnvironments,
} from './api-key';

const SECRET = 'A'.repeat(43);

describe('API key material', () => {
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

  it('derives rotatability status from durable status and expiry at the supplied time', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');

    expect(apiKeyStatus({ status: 'active', expiresAt: null }, now)).toBe(
      'active',
    );
    expect(apiKeyStatus({ status: 'active', expiresAt: now }, now)).toBe(
      'expired',
    );
    expect(
      apiKeyStatus(
        {
          status: 'revoked',
          expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe('revoked');
  });

  it('names exactly the Writing and Speaking grading scopes', () => {
    expect(isGradingScope('writing.grade')).toBe(true);
    expect(isGradingScope('speaking.grade')).toBe(true);
    expect(isGradingScope('writing.read')).toBe(false);
  });
});

describe('entitlementOfScope', () => {
  it.each([
    ['writing.grade', 'writing'],
    ['speaking', 'speaking'],
  ])('reads the leading segment of %s', (scope, entitlement) => {
    expect(entitlementOfScope(scope)).toBe(entitlement);
  });

  it.each(['', '.grade'])('names no Entitlement for %p', (scope) => {
    expect(entitlementOfScope(scope)).toBeUndefined();
  });
});

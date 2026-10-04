import {
  identityConfigFromRow,
  storedIdentityConfigFromRow,
} from './postgres-organization-identity-config.repository';

const row = {
  organizationId: 'org_acme',
  issuer: 'https://acme.edu',
  jwksUrl: 'https://acme.edu/.well-known/jwks.json',
  publicKeysJwks: null,
  allowedAlgorithms: ['RS256', 'ES256'],
  maxAssertionTtlSeconds: 300,
  status: 'active',
  jwksCacheVersion: 1n,
  updatedAt: new Date('2026-09-22T12:34:56.000Z'),
};

describe('identityConfigFromRow', () => {
  it('maps the stored settings an Organization signed assertions against', () => {
    expect(identityConfigFromRow(row)).toEqual({
      organizationId: 'org_acme',
      jwksCacheVersion: '1',
      issuer: 'https://acme.edu',
      jwksUrl: 'https://acme.edu/.well-known/jwks.json',
      publicKeysJwks: null,
      allowedAlgorithms: ['RS256', 'ES256'],
      maxAssertionTtlSeconds: 300,
      status: 'active',
    });
  });

  it('keeps a cache version above the safe integer range exact', () => {
    expect(
      identityConfigFromRow({
        ...row,
        jwksCacheVersion: 9_007_199_254_740_993n,
      })?.jwksCacheVersion,
    ).toBe('9007199254740993');
  });

  it('keeps an inline key set and a disabled status', () => {
    expect(
      identityConfigFromRow({
        ...row,
        jwksUrl: null,
        publicKeysJwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
        status: 'disabled',
      }),
    ).toMatchObject({
      jwksUrl: null,
      publicKeysJwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
      status: 'disabled',
    });
  });

  it.each([
    ['an algorithm outside the allowlist', { allowedAlgorithms: ['HS256'] }],
    ['a duplicated algorithm', { allowedAlgorithms: ['RS256', 'RS256'] }],
    ['an empty algorithm list', { allowedAlgorithms: [] }],
    ['a non-HTTPS key URL', { jwksUrl: 'http://acme.edu/jwks.json' }],
    [
      'neither a key URL nor an inline key set',
      { jwksUrl: null, publicKeysJwks: null },
    ],
    ['a TTL outside its bounds', { maxAssertionTtlSeconds: 3_601 }],
    ['a status outside its vocabulary', { status: 'pending' }],
    ['a cache version that is not a positive bigint', { jwksCacheVersion: 0n }],
  ])('refuses %s', (_reason, override) => {
    expect(identityConfigFromRow({ ...row, ...override })).toBeUndefined();
  });

  it('refuses stored private JWK members rather than returning part of them', () => {
    expect(
      identityConfigFromRow({
        ...row,
        publicKeysJwks: {
          keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', d: 'private-material' }],
        },
      }),
    ).toBeUndefined();
  });
});

describe('storedIdentityConfigFromRow', () => {
  it('adds the update time a stored configuration carries', () => {
    expect(storedIdentityConfigFromRow({ ...row, status: 'disabled' })).toEqual(
      {
        organizationId: 'org_acme',
        jwksCacheVersion: '1',
        issuer: 'https://acme.edu',
        jwksUrl: 'https://acme.edu/.well-known/jwks.json',
        publicKeysJwks: null,
        allowedAlgorithms: ['RS256', 'ES256'],
        maxAssertionTtlSeconds: 300,
        status: 'disabled',
        updatedAt: new Date('2026-09-22T12:34:56.000Z'),
      },
    );
  });

  it('refuses a row with no usable update time', () => {
    expect(
      storedIdentityConfigFromRow({ ...row, updatedAt: 'yesterday' }),
    ).toBeUndefined();
  });
});

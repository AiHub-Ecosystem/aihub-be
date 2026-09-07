import {
  type PublicJsonWebKeySet,
  parsePublicJsonWebKeySet,
} from './organization-identity-config';

const rsaKey = {
  kty: 'RSA',
  n: 'base64url-modulus',
  e: 'AQAB',
  alg: 'RS256',
  kid: 'rsa-1',
};

describe('organization identity configuration invariants', () => {
  it('accepts a public RSA/EC JWKS shape', () => {
    const result = parsePublicJsonWebKeySet({
      keys: [rsaKey, { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }],
    });

    expect(result).toEqual<PublicJsonWebKeySet>({
      keys: [rsaKey, { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }],
    });
  });

  it.each([
    undefined,
    null,
    {},
    { keys: [] },
    { keys: [{ kty: 'oct', k: 'secret' }] },
    { keys: [{ ...rsaKey, d: 'private-exponent' }] },
    { keys: [{ kty: 'RSA', n: 'missing-exponent' }] },
    { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', alg: 'RS256' }] },
  ])('rejects a non-public or incomplete JWKS: %p', (value) => {
    expect(parsePublicJsonWebKeySet(value)).toBeUndefined();
  });
});

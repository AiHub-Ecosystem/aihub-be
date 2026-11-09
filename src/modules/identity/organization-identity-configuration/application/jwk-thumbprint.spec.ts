import { jsonWebKeyThumbprint } from './jwk-thumbprint';

describe('jsonWebKeyThumbprint', () => {
  it('matches the RFC 7638 example RSA thumbprint', () => {
    // The RFC 7638 section 3.1 example key and its expected thumbprint.
    const jwk = {
      kty: 'RSA',
      n:
        '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx' +
        '4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMst' +
        'n64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2Qv' +
        'zqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD0' +
        '8qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls' +
        '1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
    };
    expect(jsonWebKeyThumbprint(jwk)).toBe(
      'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
    );
  });

  it('thumbprints an EC key from its required members only', () => {
    const thumbprint = jsonWebKeyThumbprint({
      kty: 'EC',
      crv: 'P-256',
      x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
      y: '4Etl6SRW2YiLUrN5vfvCDHh+R8Xht8bUvbBpA7utIGY',
      kid: 'ignored',
      use: 'ignored',
    });
    expect(thumbprint).toBeDefined();
    // The thumbprint ignores optional members: the same key with different
    // metadata thumbprints identically.
    expect(
      jsonWebKeyThumbprint({
        kty: 'EC',
        crv: 'P-256',
        x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
        y: '4Etl6SRW2YiLUrN5vfvCDHh+R8Xht8bUvbBpA7utIGY',
      }),
    ).toBe(thumbprint);
  });

  it('refuses a key without the members its type requires', () => {
    expect(jsonWebKeyThumbprint({ kty: 'RSA', n: 'modulus' })).toBeUndefined();
    expect(jsonWebKeyThumbprint({ kty: 'EC', x: 'a', y: 'b' })).toBeUndefined();
    expect(jsonWebKeyThumbprint({ kty: 'oct', k: 'x' })).toBeUndefined();
    expect(jsonWebKeyThumbprint({})).toBeUndefined();
  });
});

import { CompactSign, exportJWK, generateKeyPair } from 'jose';

import type { PublicJsonWebKey } from '@/modules/identity/domain/organization-identity-config';
import { JoseUserAssertionCrypto } from './jose-user-assertion-crypto';

describe('JoseUserAssertionCrypto', () => {
  it('maps a malformed Signed User Assertion payload to the invalid assertion error', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', {
      extractable: true,
    });
    const key: PublicJsonWebKey = {
      ...(await exportJWK(publicKey)),
      alg: 'RS256',
      kid: 'rsa-1',
    };
    const signedAssertion = await new CompactSign(Buffer.from('not-json'))
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .sign(privateKey);

    await expect(
      new JoseUserAssertionCrypto().verify({
        signedAssertion,
        key,
        algorithm: 'RS256',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_USER_IDENTITY',
      httpStatus: 401,
      message:
        'User identity must be a valid Signed User Assertion for this Organization',
      retryable: false,
    });
  });
});

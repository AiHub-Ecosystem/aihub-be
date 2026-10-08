import {
  type JWK,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
} from 'jose';

import type { PublicJsonWebKey } from '@/modules/identity/domain/organization-identity-config';
import type {
  UserAssertionCryptoPort,
  UserAssertionProtectedHeader,
} from '@/modules/identity/user-assertions/application/user-assertion-crypto.port';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJwk(key: PublicJsonWebKey): JWK {
  if (
    key.kty === 'RSA' &&
    typeof key.n === 'string' &&
    typeof key.e === 'string'
  ) {
    return { kty: 'RSA', n: key.n, e: key.e };
  }

  if (
    key.kty === 'EC' &&
    typeof key.crv === 'string' &&
    typeof key.x === 'string' &&
    typeof key.y === 'string'
  ) {
    return { kty: 'EC', crv: key.crv, x: key.x, y: key.y };
  }

  throw new Error('JWKS key material is invalid');
}

export class JoseUserAssertionCrypto implements UserAssertionCryptoPort {
  decodeHeader(signedAssertion: string): UserAssertionProtectedHeader {
    const header = decodeProtectedHeader(signedAssertion);
    return { alg: header.alg, kid: header.kid };
  }

  async verify(input: {
    readonly signedAssertion: string;
    readonly key: PublicJsonWebKey;
    readonly algorithm: 'RS256' | 'ES256';
  }): Promise<Readonly<Record<string, unknown>>> {
    const cryptoKey = await importJWK(toJwk(input.key), input.algorithm);
    const result = await compactVerify(input.signedAssertion, cryptoKey, {
      algorithms: [input.algorithm],
    });
    const payload: unknown = JSON.parse(
      Buffer.from(result.payload).toString('utf8'),
    );
    if (!isRecord(payload)) {
      throw new Error('User assertion payload is invalid');
    }

    return payload;
  }
}

import type { PublicJsonWebKey } from '@/modules/identity/domain/organization-identity-config';

export interface UserAssertionProtectedHeader {
  readonly alg: unknown;
  readonly kid: unknown;
}

export interface UserAssertionCryptoPort {
  decodeHeader(signedAssertion: string): UserAssertionProtectedHeader;
  verify(input: {
    readonly signedAssertion: string;
    readonly key: PublicJsonWebKey;
    readonly algorithm: 'RS256' | 'ES256';
  }): Promise<Readonly<Record<string, unknown>>>;
}

export const USER_ASSERTION_CRYPTO = Symbol('USER_ASSERTION_CRYPTO');

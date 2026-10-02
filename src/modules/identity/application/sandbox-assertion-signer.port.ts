import type { IdentityConfigAlgorithm } from '@/modules/identity/domain/organization-identity-config';

/**
 * The claim set of a sandbox assertion, already assembled and validated by the
 * application layer. The signer adds the protected header and nothing else —
 * it must never invent or override a claim, because `iss` is what binds the
 * token to a single organization.
 */
export interface SandboxAssertionClaims {
  readonly iss: string;
  readonly aud: 'aihub';
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export interface SandboxAssertionSignerPort {
  /**
   * Returns the compact-serialized assertion. The algorithm and key id come
   * from the signer's own configuration, not from the caller, so a request can
   * never select the key it is signed with.
   */
  sign(claims: SandboxAssertionClaims): Promise<string>;

  readonly algorithm: IdentityConfigAlgorithm;
}

export const SANDBOX_ASSERTION_SIGNER = Symbol('SANDBOX_ASSERTION_SIGNER');

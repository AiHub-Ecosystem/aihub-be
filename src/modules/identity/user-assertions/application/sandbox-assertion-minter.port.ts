import type { RequestContext } from '@/common/request-context/request-context';

export interface MintSandboxAssertionInput {
  /**
   * Carries the request id, the organization the API key resolved to, and the
   * deadline. The organization is read from here rather than passed beside it,
   * so there is one answer to "which tenant is this" on the way in.
   */
  readonly context: RequestContext;
  readonly userId: string;
}

export interface MintedSandboxAssertion {
  readonly assertion: string;
  readonly userId: string;
  /** Seconds since the epoch, taken from the `exp` claim. */
  readonly expiresAt: number;
  /**
   * The `jti` claim. Returned so the boundary can log which token it issued
   * without logging the token, and so a later replay control has the value it
   * would need (see 05-auth-identity.md G.6).
   */
  readonly jti: string;
}

export interface SandboxAssertionMinterPort {
  mint(input: MintSandboxAssertionInput): Promise<MintedSandboxAssertion>;
}

export const SANDBOX_ASSERTION_MINTER = Symbol('SANDBOX_ASSERTION_MINTER');

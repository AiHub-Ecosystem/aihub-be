export interface MintSandboxAssertionInput {
  readonly organizationId: string;
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

export interface UserAssertionInput {
  readonly signedAssertion: string;
  readonly organizationId: string;
}

export interface VerifiedUserAssertion {
  readonly userId: string;
  readonly organizationId: string;
  readonly scopes: readonly string[];
}

export interface UserAssertionVerifierPort {
  verify(input: UserAssertionInput): Promise<VerifiedUserAssertion>;
}

export const USER_ASSERTION_VERIFIER = Symbol('USER_ASSERTION_VERIFIER');

export interface UserIdentityInput {
  /** The raw `X-User-Identity` value. */
  readonly value: string;
  readonly organizationId: string;
}

export interface ResolvedUserIdentity {
  /** The End-User ID. */
  readonly userId: string;
  readonly organizationId: string;
  readonly scopes: readonly string[];
}

export interface UserIdentityResolverPort {
  resolve(input: UserIdentityInput): Promise<ResolvedUserIdentity>;
}

export const USER_IDENTITY_RESOLVER = Symbol('USER_IDENTITY_RESOLVER');

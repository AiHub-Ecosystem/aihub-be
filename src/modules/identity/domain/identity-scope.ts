export type IdentityScope = 'organization' | 'user';

export interface EffectiveIdentity {
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly userId?: string;
  readonly scopes: readonly string[];
}

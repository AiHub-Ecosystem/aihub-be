export interface GrantOrganizationEntitlementInput {
  readonly organizationId: string;
  readonly actorUsername: string;
  readonly entitlement: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export type GrantOrganizationEntitlementResult =
  | {
      readonly kind: 'granted' | 'unchanged';
      readonly keyHashes: readonly string[];
    }
  | { readonly kind: 'organization_not_found' }
  | { readonly kind: 'actor_invalid' };

export interface OrganizationEntitlementPort {
  grantEntitlement(
    input: GrantOrganizationEntitlementInput,
  ): Promise<GrantOrganizationEntitlementResult>;
  close(): Promise<void>;
}

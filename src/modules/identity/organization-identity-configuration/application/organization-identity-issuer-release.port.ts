export interface ReleaseOrganizationIdentityIssuerInput {
  readonly organizationId: string;
  readonly actorUsername: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export type ReleaseOrganizationIdentityIssuerResult =
  | { readonly kind: 'released' }
  | { readonly kind: 'organization_not_found' }
  | { readonly kind: 'actor_invalid' }
  | { readonly kind: 'issuer_unclaimed' };

export interface OrganizationIdentityIssuerReleasePort {
  releaseIssuer(
    input: ReleaseOrganizationIdentityIssuerInput,
  ): Promise<ReleaseOrganizationIdentityIssuerResult>;
}

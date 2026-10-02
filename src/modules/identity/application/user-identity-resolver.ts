import { isEndUserId } from '@/modules/identity/domain/end-user-id';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from './organization-identity-config-repository.port';
import type { UserAssertionVerifier } from './user-assertion-verifier';
import {
  identityProviderUnavailable,
  invalidDeclaredUserId,
} from './user-identity-errors';
import type {
  ResolvedUserIdentity,
  UserIdentityInput,
  UserIdentityResolverPort,
} from './user-identity-resolver.port';

/**
 * Chooses the User Identity form from the Organization's saved identity
 * configuration, never from the shape of the value (ADR-0053). An active
 * configuration demands a Signed User Assertion; without one, the value is a
 * Declared User ID. A configuration-store failure is an outage, not "no
 * configuration", so it never falls through to the declared form.
 */
export class UserIdentityResolver implements UserIdentityResolverPort {
  constructor(
    private readonly configRepository: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'findActiveByOrganizationId'
    >,
    private readonly verifier: Pick<UserAssertionVerifier, 'verify'>,
  ) {}

  async resolve(input: UserIdentityInput): Promise<ResolvedUserIdentity> {
    const config = await this.loadConfig(input.organizationId);
    if (config !== null) {
      return this.verifier.verify({
        signedAssertion: input.value,
        organizationId: input.organizationId,
        config,
      });
    }

    if (!isEndUserId(input.value)) {
      throw invalidDeclaredUserId();
    }

    return {
      userId: input.value,
      organizationId: input.organizationId,
      scopes: [],
    };
  }

  private async loadConfig(
    organizationId: string,
  ): Promise<OrganizationIdentityConfig | null> {
    try {
      return await this.configRepository.findActiveByOrganizationId(
        organizationId,
      );
    } catch (error) {
      throw identityProviderUnavailable(error);
    }
  }
}

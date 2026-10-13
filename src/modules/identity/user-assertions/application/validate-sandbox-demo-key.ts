import { forbidden } from '@/modules/identity/membership/application/organization-membership.authorization';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { identityProviderUnavailable } from './user-identity-errors';

/** Same Safe Authorization Denial the guards give, message included. */
const NOT_AUTHORIZED = 'API key is not authorized for this operation';

export interface ValidateSandboxDemoKeyInput {
  readonly organizationId: string;
  readonly scope: string;
  /** Scopes the authenticated API key carries. */
  readonly grantedScopes: readonly string[];
}

export interface SandboxDemoKeyEligibility {
  readonly valid: true;
}

/**
 * Decides whether an authenticated sandbox key may grade the requested scope.
 *
 * The Organization must have no active Identity Configuration: a configured
 * Organization authenticates its end users through signed assertions rather
 * than through a customer-managed key, so its key is not a demo credential. The
 * repository is reached here, in the application layer, so the lookup and the
 * translation of a persistence failure stay out of the controller.
 */
export class ValidateSandboxDemoKey {
  constructor(
    private readonly identityConfig: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'findActiveByOrganizationId'
    >,
  ) {}

  async validate(
    input: ValidateSandboxDemoKeyInput,
  ): Promise<SandboxDemoKeyEligibility> {
    if (!input.grantedScopes.includes(input.scope)) {
      throw forbidden(NOT_AUTHORIZED);
    }

    let configured: OrganizationIdentityConfig | null;
    try {
      configured = await this.identityConfig.findActiveByOrganizationId(
        input.organizationId,
      );
    } catch (error) {
      throw identityProviderUnavailable(error);
    }
    if (configured !== null) throw forbidden(NOT_AUTHORIZED);

    return { valid: true };
  }
}

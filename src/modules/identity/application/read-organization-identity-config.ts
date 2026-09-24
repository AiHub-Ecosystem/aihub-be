import type { RequestContext } from '../../../common/request-context/request-context';
import type { OrganizationIdentityConfigRepositoryPort } from './organization-identity-config-repository.port';
import type { StoredOrganizationIdentityConfig } from './organization-identity-config-repository.port';
import {
  forbidden,
  requireActiveMembership,
} from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

const IDENTITY_CONFIG_ACCESS_FORBIDDEN =
  'Organization identity configuration access is forbidden';

export interface ReadOrganizationIdentityConfigCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
}

export type ReadOrganizationIdentityConfigResult =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly config: StoredOrganizationIdentityConfig;
    };

export class ReadOrganizationIdentityConfig {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly configs: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'findByOrganizationId'
    >,
  ) {}

  async read(
    input: ReadOrganizationIdentityConfigCommand,
  ): Promise<ReadOrganizationIdentityConfigResult> {
    const caller = await requireActiveMembership(
      this.membership,
      {
        context: input.context,
        userId: input.userId,
        organizationId: input.organizationId,
      },
      IDENTITY_CONFIG_ACCESS_FORBIDDEN,
    );

    if (caller.role !== 'owner' || caller.organizationStatus === 'suspended') {
      throw forbidden(IDENTITY_CONFIG_ACCESS_FORBIDDEN);
    }

    const config = await this.configs.findByOrganizationId(
      input.organizationId,
    );
    return config === null
      ? { configured: false }
      : { configured: true, config };
  }
}

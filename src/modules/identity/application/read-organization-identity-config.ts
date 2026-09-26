import type { RequestContext } from '../../../common/request-context/request-context';
import { admitOrganizationRead } from './organization-admission';
import type { OrganizationIdentityConfigRepositoryPort } from './organization-identity-config-repository.port';
import type { StoredOrganizationIdentityConfig } from './organization-identity-config-repository.port';
import type { OrganizationMembershipPort } from './organization-membership.port';

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
    const admission = await admitOrganizationRead(this.membership, {
      surface: 'identity_configuration',
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });
    if (!admission.admitted) {
      throw admission.refusal;
    }

    const config = await this.configs.findByOrganizationId(
      input.organizationId,
    );
    return config === null
      ? { configured: false }
      : { configured: true, config };
  }
}

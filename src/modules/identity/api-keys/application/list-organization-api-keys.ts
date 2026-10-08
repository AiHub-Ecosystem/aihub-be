import type { RequestContext } from '@/common/request-context/request-context';
import { apiKeyStatus } from '@/modules/identity/domain/api-key';

import type { OrganizationApiKeyView } from './organization-api-key-view';

import { admitOrganizationApiKey } from '@/modules/identity/membership/application/organization-admission';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import type { OrganizationApiKeyPort } from './organization-api-key.port';

export interface ListOrganizationApiKeysCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
}

/**
 * Reads an Organization's live API-key inventory for an authorized owner or
 * admin.
 *
 * A suspended Organization is denied, matching the open-invitation listing
 * rather than the self-roster: both are organization-scoped management lists
 * behind this authority, while the roster is a caller's own view across every
 * Organization and is a different shape.
 */
export class ListOrganizationApiKeys {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly apiKeys: Pick<OrganizationApiKeyPort, 'listApiKeys'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    input: ListOrganizationApiKeysCommand,
  ): Promise<readonly OrganizationApiKeyView[]> {
    const admission = await admitOrganizationApiKey(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      surface: 'api_key_list',
    });
    if (!admission.admitted) {
      throw admission.refusal;
    }

    const now = this.now();
    const keys = await this.apiKeys.listApiKeys({
      context: input.context,
      organizationId: input.organizationId,
    });

    // The store settles which keys and in what order; this only projects the
    // published lifecycle onto each one.
    return keys.map((key) => ({
      id: key.apiKeyId,
      name: key.name,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      allowedEnvironments: key.allowedEnvironments,
      status: apiKeyStatus(key, now),
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
    }));
  }
}

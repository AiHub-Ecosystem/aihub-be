import { AppError } from '../../../common/errors/app-error';
import type { RequestContext } from '../../../common/request-context/request-context';
import { apiKeyStatus } from '../domain/api-key';

import type { OrganizationApiKeyView } from './organization-api-key-view';

import type { OrganizationApiKeyPort } from './organization-api-key.port';
import { requireActiveMembership } from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

export interface ListOrganizationApiKeysCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
}

function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
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
    const caller = await requireActiveMembership(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    if (caller.organizationStatus === 'suspended') {
      throw forbidden('Organization is suspended');
    }

    if (caller.role === 'member') {
      throw forbidden('Organization membership role cannot list API keys');
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

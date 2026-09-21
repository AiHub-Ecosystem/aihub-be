import { AppError } from '../../../common/errors/app-error';
import type { RequestContext } from '../../../common/request-context/request-context';
import { apiKeyStatus } from '../domain/api-key';

import type { ApiKeyCachePort } from './api-key-authenticator.port';
import type { OrganizationApiKeyView } from './organization-api-key-view';
import type { OrganizationApiKeyPort } from './organization-api-key.port';
import { requireActiveMembership } from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

export interface RevokeOrganizationApiKeyCommand {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly apiKeyId: string;
}

function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
}

/**
 * Withdraws one Organization API key, keeping its durable row.
 *
 * State-idempotent: a key already withdrawn is reported as withdrawn rather
 * than as a conflict. Revocation is run during incident response, often twice
 * and often by a retrying script, and a second attempt has found its goal
 * already met.
 */
export class RevokeOrganizationApiKey {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly apiKeys: Pick<OrganizationApiKeyPort, 'revokeApiKey'>,
    private readonly cache: Pick<ApiKeyCachePort, 'delete'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async revoke(
    input: RevokeOrganizationApiKeyCommand,
  ): Promise<OrganizationApiKeyView> {
    const caller = await requireActiveMembership(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    if (caller.organizationStatus === 'suspended') {
      throw forbidden('Organization is suspended');
    }

    if (caller.role === 'member') {
      throw forbidden('Organization membership role cannot revoke API keys');
    }

    const now = this.now();
    const result = await this.apiKeys.revokeApiKey({
      context: input.context,
      organizationId: input.organizationId,
      actorUserId: input.userId,
      apiKeyId: input.apiKeyId,
      now,
    });

    if (result.kind === 'key_not_found') {
      // An unknown key and another tenant's key are deliberately one outcome.
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'API key was not found',
        retryable: false,
      });
    }
    if (result.kind === 'organization_unavailable') {
      throw forbidden('Organization is not active');
    }

    // Purged on the repeat request too, not only when this call changed
    // something: an earlier purge can have failed without telling anyone, and
    // running the withdrawal again is the only way an operator can close the
    // window it left open. Its failure must not fail work already committed.
    await this.cache.delete(result.keyHash).catch(() => undefined);

    const key = result.key;
    return {
      id: key.apiKeyId,
      name: key.name,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      allowedEnvironments: key.allowedEnvironments,
      status: apiKeyStatus(key, now),
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
    };
  }
}

import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';

import type { ApiKeyCachePort } from './api-key-authenticator.port';
import {
  ORGANIZATION_API_KEY_ADMISSION,
  admitOrganizationApiKey,
} from './organization-admission';
import { generateOrganizationApiKey } from './organization-api-key-generator';
import type { OrganizationApiKeyPort } from './organization-api-key.port';
import { forbidden } from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

export interface RotateOrganizationApiKeyInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  /** The key being retired. */
  readonly apiKeyId: string;
}

export interface RotatedOrganizationApiKey {
  readonly apiKey: string;
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Replaces an Organization's credential while preserving the authority it
 * carried, and discloses the raw replacement exactly once.
 *
 * The replacement inherits name, scopes, allowed environments, and expiry from
 * the store rather than from the request: rotation changes the credential, not
 * what the credential may do.
 */
export class RotateOrganizationApiKey {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly apiKeys: Pick<OrganizationApiKeyPort, 'rotateApiKey'>,
    private readonly cache: Pick<ApiKeyCachePort, 'delete'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async rotate(
    input: RotateOrganizationApiKeyInput,
  ): Promise<RotatedOrganizationApiKey> {
    const admission = await admitOrganizationApiKey(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      surface: 'api_key_rotate',
    });
    if (!admission.admitted) {
      throw admission.refusal;
    }

    const now = this.now();
    const generated = generateOrganizationApiKey(now);
    const result = await this.apiKeys.rotateApiKey({
      context: input.context,
      organizationId: input.organizationId,
      actorUserId: input.userId,
      apiKeyId: input.apiKeyId,
      replacementId: generated.id,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      now,
    });

    if (result.kind === 'key_not_found') {
      // An unknown key and another tenant's key are deliberately one outcome:
      // telling them apart would make this a probe for identifiers elsewhere.
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'API key was not found',
        retryable: false,
      });
    }
    if (result.kind === 'key_not_rotatable') {
      throw forbidden('API key cannot be rotated');
    }
    if (result.kind === 'organization_unavailable') {
      throw forbidden(ORGANIZATION_API_KEY_ADMISSION.api_key_rotate.refusal);
    }

    // The durable change is committed by this point. Purging only closes the
    // window in which the cache would still admit the retired key, so its
    // failure must not fail the request: doing so would withhold the only copy
    // of a credential the caller now has to use, while the key it replaces is
    // already revoked. The resulting ceiling is the known operational risk
    // ADR-0027 accepted, not a grace window.
    await this.cache.delete(result.retiredKeyHash).catch(() => undefined);

    return {
      apiKey: generated.raw,
      id: generated.id,
      organizationId: input.organizationId,
      name: result.name,
      keyPrefix: generated.prefix,
      scopes: result.scopes,
      allowedEnvironments: result.allowedEnvironments,
      expiresAt: result.expiresAt,
      createdAt: result.createdAt,
    };
  }
}

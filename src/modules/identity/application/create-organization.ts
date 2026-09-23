import { AppError } from '../../../common/errors/app-error';
import { invalidRequest } from '../../../common/errors/invalid-request';
import type { RequestContext } from '../../../common/request-context/request-context';
import { organizationName } from '../domain/organization-name';

import type {
  OrganizationCreationPort,
  SelfServeOrganizationTerms,
} from './organization-creation.port';

export interface CreateOrganizationInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly name: string;
}

export interface CreatedOrganization {
  readonly organizationId: string;
  readonly name: string;
  readonly status: 'active';
  readonly role: 'owner';
}

/**
 * Self-serve terms are tighter than an operator's defaults because no
 * commercial agreement exists yet: `writing` lets the owner issue a usable key
 * at once, and the hard-stopped quota caps what that key can cost (ADR-0041).
 */
export const SELF_SERVE_ORGANIZATION_TERMS: SelfServeOrganizationTerms = {
  entitlements: ['writing'],
  rateLimitRpm: 60,
  maxConcurrent: 5,
  monthlyRequestQuota: 100,
  hardStopOnQuota: true,
};

/** Lifetime Self-serve Organization creations per AIHUB User Account. */
export const ORGANIZATION_CREATION_LIMIT = 3;

/**
 * Creates a Self-serve Organization and makes its caller the first active
 * owner. No membership is consulted first: the caller is not yet a member of
 * anything this act concerns, and the account itself is the only authority.
 */
export class CreateOrganization {
  constructor(private readonly organizations: OrganizationCreationPort) {}

  async create(input: CreateOrganizationInput): Promise<CreatedOrganization> {
    const name = organizationName(input.name);
    if (name === undefined) {
      throw invalidRequest();
    }

    const result = await this.organizations.createOrganization({
      context: input.context,
      creatorUserId: input.userId,
      name,
      terms: SELF_SERVE_ORGANIZATION_TERMS,
      creationLimit: ORGANIZATION_CREATION_LIMIT,
    });

    if (result.kind === 'limit_reached') {
      throw new AppError({
        code: 'ORGANIZATION_CREATION_LIMIT_REACHED',
        message: 'Organization creation limit reached',
        retryable: false,
      });
    }
    if (result.kind === 'account_inactive') {
      // The account changed state after the Bearer guard admitted it; answer
      // as the guard would have, so account state is not disclosed.
      throw new AppError({
        code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
        message: 'User access token is invalid',
        retryable: false,
      });
    }

    return {
      organizationId: result.organizationId,
      name,
      status: 'active',
      role: 'owner',
    };
  }
}

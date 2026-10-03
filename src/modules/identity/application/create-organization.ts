import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { RequestContext } from '@/common/request-context/request-context';
import { organizationName } from '@/modules/identity/domain/organization-name';

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
 * Self-serve Organizations start with every currently available capability;
 * the hard-stopped quota still caps usage under the default commercial terms.
 */
export const DEFAULT_MONTHLY_REQUEST_QUOTA = 100;

export class SelfServeTermsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfServeTermsConfigurationError';
  }
}

/**
 * The default monthly request quota is deployment configuration, not a
 * business constant: a test environment raises it without a code change.
 *
 * Zero is refused on purpose. `organizations.monthly_request_quota` accepts
 * zero for an operator who deliberately wants an Organization that cannot
 * bill anything, but a Self-serve Organization created from a mistyped
 * variable would be born unable to answer a single request, and "no limit"
 * already has its own value: NULL. A mistyped quota should stop the process
 * at boot rather than hand a customer a dead Organization.
 */
export function selfServeMonthlyRequestQuota(
  value: string | undefined,
): number {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_MONTHLY_REQUEST_QUOTA;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new SelfServeTermsConfigurationError(
      'AIHUB_SELF_SERVE_MONTHLY_REQUEST_QUOTA must be a positive integer',
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new SelfServeTermsConfigurationError(
      'AIHUB_SELF_SERVE_MONTHLY_REQUEST_QUOTA is out of range',
    );
  }
  return parsed;
}

export function selfServeOrganizationTerms(
  monthlyRequestQuota: number,
): SelfServeOrganizationTerms {
  return {
    entitlements: ['writing', 'speaking'],
    rateLimitRpm: 60,
    maxConcurrent: 5,
    monthlyRequestQuota,
    hardStopOnQuota: true,
  };
}

/** Lifetime Self-serve Organization creations per AIHUB User Account. */
export const ORGANIZATION_CREATION_LIMIT = 3;

/**
 * Creates a Self-serve Organization and makes its caller the first active
 * owner. No membership is consulted first: the caller is not yet a member of
 * anything this act concerns, and the account itself is the only authority.
 */
export class CreateOrganization {
  constructor(
    private readonly organizations: OrganizationCreationPort,
    private readonly terms: SelfServeOrganizationTerms,
  ) {}

  async create(input: CreateOrganizationInput): Promise<CreatedOrganization> {
    const name = organizationName(input.name);
    if (name === undefined) {
      throw invalidRequest();
    }

    const result = await this.organizations.createOrganization({
      context: input.context,
      creatorUserId: input.userId,
      name,
      terms: this.terms,
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

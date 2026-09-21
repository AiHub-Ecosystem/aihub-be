import { publishedScopes } from '../../../catalog/operation-catalog';
import { AppError } from '../../../common/errors/app-error';
import { invalidRequest } from '../../../common/errors/invalid-request';
import type { RequestContext } from '../../../common/request-context/request-context';
import { generateApiKey } from '../domain/api-key';

import type { OrganizationApiKeyPort } from './organization-api-key.port';
import { requireActiveMembership } from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

/** Customer-facing request tiers. AIHUB's sandbox and development are not. */
const CUSTOMER_ENVIRONMENTS: readonly string[] = ['production', 'staging'];
const DEFAULT_ENVIRONMENTS: readonly string[] = ['production'];
const MAX_KEY_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * An Organization cannot hold an unbounded number of live credentials, so one
 * compromised owner session cannot mint keys without limit. Enforced inside the
 * creating transaction rather than by a constraint: this slice adds no schema
 * change.
 */
export const ACTIVE_API_KEY_LIMIT = 50;

export interface CreateOrganizationApiKeyInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments?: readonly string[];
  readonly expiresAt?: string;
}

export interface CreatedOrganizationApiKey {
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

function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
}

/**
 * An Entitlement is the leading segment of a Scope: `writing.grade` requires
 * `writing`.
 */
function entitlementOf(scope: string): string | undefined {
  const [entitlement] = scope.split('.');
  return entitlement === undefined || entitlement.length === 0
    ? undefined
    : entitlement;
}

function validatedScopes(scopes: readonly string[]): readonly string[] {
  const published = new Set(publishedScopes());
  const requested = [...new Set(scopes)];

  if (
    requested.length === 0 ||
    requested.some((scope) => !published.has(scope))
  ) {
    throw invalidRequest();
  }

  return requested;
}

function validatedEnvironments(
  environments: readonly string[] | undefined,
): readonly string[] {
  if (environments === undefined) {
    return DEFAULT_ENVIRONMENTS;
  }

  const requested = [...new Set(environments)];
  if (
    requested.length === 0 ||
    requested.some(
      (environment) => !CUSTOMER_ENVIRONMENTS.includes(environment),
    )
  ) {
    throw invalidRequest();
  }

  return requested;
}

function validatedExpiry(
  expiresAt: string | undefined,
  now: Date,
): Date | null {
  if (expiresAt === undefined) {
    return null;
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidRequest();
  }

  const lifetimeMs = parsed.getTime() - now.getTime();
  // A cap is what makes the expiry field mean something; without it an expiry
  // far enough out is indistinguishable from no expiry at all.
  if (lifetimeMs <= 0 || lifetimeMs > MAX_KEY_LIFETIME_MS) {
    throw invalidRequest();
  }

  return parsed;
}

/**
 * Creates an Organization-owned API key for an authorized owner or admin and
 * discloses the raw credential exactly once.
 *
 * Authorization is settled before a credential is generated at all, so an
 * unauthorized caller never causes one to exist.
 */
export class CreateOrganizationApiKey {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly apiKeys: OrganizationApiKeyPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    input: CreateOrganizationApiKeyInput,
  ): Promise<CreatedOrganizationApiKey> {
    const caller = await requireActiveMembership(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    if (caller.organizationStatus === 'suspended') {
      throw forbidden('Organization is suspended');
    }

    if (caller.role === 'member') {
      throw forbidden('Organization membership role cannot create API keys');
    }

    const now = this.now();
    const scopes = validatedScopes(input.scopes);
    const allowedEnvironments = validatedEnvironments(
      input.allowedEnvironments,
    );
    const expiresAt = validatedExpiry(input.expiresAt, now);

    const requiredEntitlements = [
      ...new Set(
        scopes.map((scope) => {
          const entitlement = entitlementOf(scope);
          if (entitlement === undefined) {
            throw invalidRequest();
          }
          return entitlement;
        }),
      ),
    ];

    const generated = generateApiKey(now);
    const result = await this.apiKeys.createApiKey({
      context: input.context,
      organizationId: input.organizationId,
      actorUserId: input.userId,
      apiKeyId: generated.id,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      name: input.name,
      scopes,
      allowedEnvironments,
      expiresAt,
      requiredEntitlements,
      activeKeyLimit: ACTIVE_API_KEY_LIMIT,
    });

    if (result.kind === 'entitlements_missing') {
      throw forbidden('Organization is not entitled to the requested scopes');
    }
    if (result.kind === 'limit_reached') {
      throw forbidden('Organization has reached its active API key limit');
    }
    if (result.kind === 'organization_unavailable') {
      throw forbidden('Organization is not active');
    }

    return {
      apiKey: generated.raw,
      id: generated.id,
      organizationId: input.organizationId,
      name: input.name,
      keyPrefix: generated.prefix,
      scopes,
      allowedEnvironments,
      expiresAt,
      createdAt: result.createdAt,
    };
  }
}

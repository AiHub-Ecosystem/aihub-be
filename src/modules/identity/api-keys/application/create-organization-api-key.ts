import { publishedScopes } from '@/catalog/operation-catalog';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { RequestContext } from '@/common/request-context/request-context';
import {
  type KeyEnvironment,
  entitlementOfScope,
  isGradingScope,
} from '@/modules/identity/domain/api-key';
import { isDisplayText } from '@/modules/identity/domain/display-text';
import {
  ORGANIZATION_API_KEY_ADMISSION,
  admitOrganizationApiKey,
} from '@/modules/identity/membership/application/organization-admission';
import { forbidden } from '@/modules/identity/membership/application/organization-membership.authorization';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import { generateOrganizationApiKey } from './organization-api-key-generator';
import type { OrganizationApiKeyPort } from './organization-api-key.port';

/** Only the two public customer environments have an issued key prefix. */
type CustomerKeyEnvironment = Exclude<KeyEnvironment, 'staging'>;
const DEFAULT_ENVIRONMENTS: readonly CustomerKeyEnvironment[] = ['production'];
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

function validatedName(name: string): string {
  if (name.trim().length === 0 || !isDisplayText(name)) {
    throw invalidRequest();
  }
  return name;
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

/** New customer key requests support only the public Sandbox and Production tiers. */
function validatedEnvironments(
  environments: readonly string[] | undefined,
): readonly CustomerKeyEnvironment[] {
  const requested =
    environments === undefined
      ? [...DEFAULT_ENVIRONMENTS]
      : [...new Set(environments)];

  if (requested.length !== 1) {
    throw invalidRequest();
  }

  const environment = requested[0];
  if (environment !== 'production' && environment !== 'sandbox') {
    throw invalidRequest();
  }
  return [environment];
}

function validateSandboxKey(
  scopes: readonly string[],
  environments: readonly string[],
): void {
  if (
    environments.includes('sandbox') &&
    scopes.some((scope) => !isGradingScope(scope))
  ) {
    throw invalidRequest();
  }
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
    const admission = await admitOrganizationApiKey(this.membership, {
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      surface: 'api_key_create',
    });
    if (!admission.admitted) {
      throw admission.refusal;
    }

    const now = this.now();
    const name = validatedName(input.name);
    const scopes = validatedScopes(input.scopes);
    const allowedEnvironments = validatedEnvironments(
      input.allowedEnvironments,
    );
    validateSandboxKey(scopes, allowedEnvironments);
    const expiresAt = validatedExpiry(input.expiresAt, now);

    const requiredEntitlements = [
      ...new Set(
        scopes.map((scope) => {
          const entitlement = entitlementOfScope(scope);
          if (entitlement === undefined) {
            throw invalidRequest();
          }
          return entitlement;
        }),
      ),
    ];

    const generated = generateOrganizationApiKey(now, allowedEnvironments[0]);
    const result = await this.apiKeys.createApiKey({
      context: input.context,
      organizationId: input.organizationId,
      actorUserId: input.userId,
      apiKeyId: generated.id,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      name,
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
      throw forbidden(ORGANIZATION_API_KEY_ADMISSION.api_key_create.refusal);
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

import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { RequestContext } from '@/common/request-context/request-context';
import {
  IDENTITY_CONFIG_ALGORITHMS,
  isSafeJwksUrl,
  parsePublicJsonWebKeySet,
} from '@/modules/identity/domain/organization-identity-config';
import {
  forbidden,
  requireActiveMembership,
} from '@/modules/identity/membership/application/organization-membership.authorization';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import {
  invalidJwks,
  unsafeJwksUrl,
} from '@/modules/identity/shared/application/jwks-errors';
import type { JwksCachePort } from '@/modules/identity/user-assertions/application/jwks-cache.port';
import type { JwksKeyProviderPort } from '@/modules/identity/user-assertions/application/jwks-key-provider.port';
import type {
  IdentityConfigAlgorithm,
  OrganizationIdentityConfigRepositoryPort,
  StoredOrganizationIdentityConfig,
} from './organization-identity-config-repository.port';

const IDENTITY_CONFIG_ACCESS_FORBIDDEN =
  'Organization identity configuration access is forbidden';
const DEFAULT_MAX_ASSERTION_TTL_SECONDS = 300;

export interface SetOrganizationIdentityConfigInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly issuer: string;
  readonly jwksUrl?: string | null;
  readonly publicKeysJwks?: unknown;
  readonly allowedAlgorithms?: readonly IdentityConfigAlgorithm[];
  readonly maxAssertionTtlSeconds?: number;
}

export type SetOrganizationIdentityConfigResult =
  StoredOrganizationIdentityConfig;

function cacheUnavailable(): AppError {
  return new AppError({
    code: 'IDENTITY_CONFIG_CACHE_UNAVAILABLE',
    message: 'Identity configuration cache could not be cleared',
    retryable: true,
  });
}

export class SetOrganizationIdentityConfig {
  constructor(
    private readonly membership: Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    >,
    private readonly configs: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'saveForOwner'
    >,
    private readonly keys: Pick<JwksKeyProviderPort, 'validateRemote'>,
    private readonly cache: Pick<JwksCachePort, 'deleteJwks'>,
  ) {}

  async set(
    input: SetOrganizationIdentityConfigInput,
  ): Promise<SetOrganizationIdentityConfigResult> {
    const caller = await requireActiveMembership(
      this.membership,
      {
        context: input.context,
        userId: input.userId,
        organizationId: input.organizationId,
      },
      IDENTITY_CONFIG_ACCESS_FORBIDDEN,
    );
    if (caller.role !== 'owner' || caller.organizationStatus !== 'active') {
      throw forbidden(IDENTITY_CONFIG_ACCESS_FORBIDDEN);
    }

    const issuer = input.issuer.trim();
    const jwksUrl =
      typeof input.jwksUrl === 'string' ? input.jwksUrl.trim() : null;
    const publicKeysJwks =
      input.publicKeysJwks === undefined || input.publicKeysJwks === null
        ? null
        : parsePublicJsonWebKeySet(input.publicKeysJwks);
    const allowedAlgorithms = input.allowedAlgorithms ?? [
      ...IDENTITY_CONFIG_ALGORITHMS,
    ];
    const maxAssertionTtlSeconds =
      input.maxAssertionTtlSeconds ?? DEFAULT_MAX_ASSERTION_TTL_SECONDS;
    const hasInlineSource =
      input.publicKeysJwks !== undefined && input.publicKeysJwks !== null;

    if (
      issuer.length === 0 ||
      // Bytes, not characters: the issuer's unique btree index refuses an
      // entry past 2,704 bytes, and 2,048 multibyte characters exceed it.
      Buffer.byteLength(issuer, 'utf8') > 2_048 ||
      (jwksUrl === null) === !hasInlineSource ||
      (jwksUrl !== null && jwksUrl.length === 0) ||
      allowedAlgorithms.length === 0 ||
      new Set(allowedAlgorithms).size !== allowedAlgorithms.length ||
      allowedAlgorithms.some(
        (algorithm) => !IDENTITY_CONFIG_ALGORITHMS.includes(algorithm),
      ) ||
      !Number.isInteger(maxAssertionTtlSeconds) ||
      maxAssertionTtlSeconds < 1 ||
      maxAssertionTtlSeconds > 3_600
    ) {
      throw invalidRequest();
    }

    if (jwksUrl !== null && !isSafeJwksUrl(jwksUrl)) {
      throw unsafeJwksUrl();
    }
    if (hasInlineSource && publicKeysJwks === undefined) {
      throw invalidJwks();
    }

    if (jwksUrl !== null) {
      await this.keys.validateRemote({
        organizationId: input.organizationId,
        url: jwksUrl,
      });
    }

    const saved = await this.configs.saveForOwner({
      context: input.context,
      userId: input.userId,
      organizationId: input.organizationId,
      issuer,
      jwksUrl,
      publicKeysJwks: publicKeysJwks ?? null,
      allowedAlgorithms,
      maxAssertionTtlSeconds,
      sourceKind: jwksUrl === null ? 'inline' : 'url',
    });
    if (saved.kind === 'forbidden') {
      throw forbidden(IDENTITY_CONFIG_ACCESS_FORBIDDEN);
    }

    try {
      await this.cache.deleteJwks(
        input.organizationId,
        saved.config.jwksCacheVersion ?? '1',
      );
    } catch {
      throw cacheUnavailable();
    }

    return saved.config;
  }
}

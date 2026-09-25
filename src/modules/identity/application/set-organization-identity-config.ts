import { AppError } from '../../../common/errors/app-error';
import { invalidRequest } from '../../../common/errors/invalid-request';
import type { RequestContext } from '../../../common/request-context/request-context';
import {
  IDENTITY_CONFIG_ALGORITHMS,
  parsePublicJsonWebKeySet,
} from '../domain/organization-identity-config';

import type { JwksCachePort } from './jwks-cache.port';
import type { JwksKeyProviderPort } from './jwks-key-provider.port';
import type {
  IdentityConfigAlgorithm,
  OrganizationIdentityConfigRepositoryPort,
  StoredOrganizationIdentityConfig,
} from './organization-identity-config-repository.port';
import {
  forbidden,
  requireActiveMembership,
} from './organization-membership.authorization';
import type { OrganizationMembershipPort } from './organization-membership.port';

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

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function cacheUnavailable(): AppError {
  return new AppError({
    code: 'IDENTITY_CONFIG_CACHE_UNAVAILABLE',
    message: 'Identity configuration cache could not be cleared',
    retryable: true,
  });
}

function invalidJwks(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_INVALID',
    message: 'Public JWKS is invalid',
    retryable: false,
  });
}

function unsafeJwksUrl(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_URL_UNSAFE',
    message: 'JWKS URL is not safe',
    retryable: false,
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
      issuer.length > 2_048 ||
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

    if (jwksUrl !== null && !httpsUrl(jwksUrl)) {
      throw unsafeJwksUrl();
    }
    if (hasInlineSource && publicKeysJwks === undefined) {
      throw invalidJwks();
    }

    if (jwksUrl !== null) {
      await this.keys.validateRemote(jwksUrl);
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

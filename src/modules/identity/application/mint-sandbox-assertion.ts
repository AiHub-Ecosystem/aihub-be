import { randomUUID } from 'node:crypto';

import { AppError } from '../../../common/errors/app-error';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from './organization-identity-config-repository.port';
import type {
  MintSandboxAssertionInput,
  MintedSandboxAssertion,
  SandboxAssertionMinterPort,
} from './sandbox-assertion-minter.port';
import type { SandboxAssertionSignerPort } from './sandbox-assertion-signer.port';

const MAX_USER_ID_LENGTH = 128;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function invalidRequest(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    retryable: false,
  });
}

function configurationError(cause?: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Sandbox assertion configuration is invalid',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function identityProviderUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    message: 'Identity provider is unavailable',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Mints a user assertion for one sandbox organization.
 *
 * Every claim except the end-user identifier is derived here. The issuer and
 * the lifetime come from the organization's own identity configuration rather
 * than from this service's environment, which keeps the minted token in step
 * with what `UserAssertionVerifier` will later demand of it: the verifier
 * compares `iss` against the config of the organization resolved from the API
 * key, so a token minted from any other issuer could never verify. That is the
 * containment property this endpoint rests on — an assertion produced here is
 * accepted by the sandbox organization and by nothing else.
 */
export class MintSandboxAssertion implements SandboxAssertionMinterPort {
  constructor(
    private readonly configRepository: OrganizationIdentityConfigRepositoryPort,
    private readonly signer: SandboxAssertionSignerPort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly newJti: () => string = randomUUID,
  ) {}

  async mint(
    input: MintSandboxAssertionInput,
  ): Promise<MintedSandboxAssertion> {
    const userId = input.userId.trim();
    if (
      userId.length === 0 ||
      userId.length > MAX_USER_ID_LENGTH ||
      !USER_ID_PATTERN.test(userId)
    ) {
      throw invalidRequest();
    }

    const config = await this.loadConfig(input.organizationId);

    // Signing with an algorithm the organization does not allow would produce
    // tokens that fail verification every time, with nothing at the failure
    // site to explain why. Fail here, where the misconfiguration is visible.
    if (!config.allowedAlgorithms.includes(this.signer.algorithm)) {
      throw configurationError();
    }

    const issuedAt = this.now();
    const expiresAt = issuedAt + config.maxAssertionTtlSeconds;
    const jti = this.newJti();
    const assertion = await this.signer.sign({
      iss: config.issuer,
      aud: 'aihub',
      sub: userId,
      jti,
      iat: issuedAt,
      exp: expiresAt,
    });

    return { assertion, userId, expiresAt, jti };
  }

  private async loadConfig(
    organizationId: string,
  ): Promise<OrganizationIdentityConfig> {
    let config: OrganizationIdentityConfig | null;
    try {
      config =
        await this.configRepository.findActiveByOrganizationId(organizationId);
    } catch (error) {
      throw identityProviderUnavailable(error);
    }

    // The allowlist named this organization, so a missing or disabled identity
    // configuration is an operator mistake, not a caller mistake.
    if (config === null) {
      throw configurationError();
    }

    return config;
  }
}

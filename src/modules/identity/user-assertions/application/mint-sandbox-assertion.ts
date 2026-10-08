import { randomUUID } from 'node:crypto';

import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { isSandboxUserId } from '@/modules/identity/domain/sandbox-user-id';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type {
  MintSandboxAssertionInput,
  MintedSandboxAssertion,
  SandboxAssertionMinterPort,
} from './sandbox-assertion-minter.port';
import type { SandboxAssertionSignerPort } from './sandbox-assertion-signer.port';
import { identityProviderUnavailable } from './user-identity-errors';

function configurationError(cause?: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Sandbox assertion configuration is invalid',
    retryable: false,
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
    private readonly configRepository: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'findActiveByOrganizationId'
    >,
    private readonly signer: SandboxAssertionSignerPort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly newJti: () => string = randomUUID,
  ) {}

  async mint(
    input: MintSandboxAssertionInput,
  ): Promise<MintedSandboxAssertion> {
    const { userId } = input;
    const organizationId = input.context.organizationId ?? '';

    // Checked again behind the transport schema that already checked it: the
    // port is a seam, and the next caller through it may not be a controller.
    // Both checks read the same domain rule, so neither can be stricter than
    // the other and leave an unreachable branch behind.
    if (!isSandboxUserId(userId)) {
      throw invalidRequest();
    }

    // The guard resolves the organization from the API key before this runs,
    // so a context without one is a wiring fault, not a caller fault.
    if (organizationId.length === 0) {
      throw configurationError();
    }

    const config = await this.loadConfig(organizationId);

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

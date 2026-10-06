import type {
  RuntimeConfiguration,
  RuntimeConnectionConfiguration,
} from '@/config/runtime-configuration';
import type { SandboxAssertionPolicyPort } from '@/modules/identity/application/sandbox-assertion-policy.port';
import {
  readSandboxOrganizationIds,
  readSandboxSigningMaterial,
} from './sandbox-assertion.config';

/**
 * Resolves the sandbox allowlist from injected runtime configuration.
 *
 * Reading per call keeps policy checks current for the configured provider
 * and costs nothing on a route that is not on the hot path.
 */
export class EnvSandboxAssertionPolicy implements SandboxAssertionPolicyPort {
  constructor(
    private readonly configuration: Pick<
      RuntimeConfiguration,
      'AIHUB_SANDBOX_ORG_IDS'
    >,
    private readonly connection: Pick<
      RuntimeConnectionConfiguration,
      'sandboxAssertionPrivateKey' | 'sandboxAssertionKeyId'
    >,
  ) {}

  /**
   * Both halves must be present. An allowlist without a key would accept the
   * request and then fail to sign it, and a key without an allowlist has
   * nobody entitled to use it.
   */
  isEnabled(): boolean {
    return (
      readSandboxOrganizationIds(this.configuration).length > 0 &&
      readSandboxSigningMaterial(this.connection) !== undefined
    );
  }

  allows(organizationId: string): boolean {
    return (
      this.isEnabled() &&
      readSandboxOrganizationIds(this.configuration).includes(organizationId)
    );
  }

  isConfiguredOrganization(organizationId: string): boolean {
    return readSandboxOrganizationIds(this.configuration).includes(
      organizationId,
    );
  }
}

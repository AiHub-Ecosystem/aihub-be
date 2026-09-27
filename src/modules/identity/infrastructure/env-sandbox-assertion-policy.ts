import type { SandboxAssertionPolicyPort } from '../application/sandbox-assertion-policy.port';
import {
  readSandboxOrganizationIds,
  readSandboxSigningMaterial,
} from './sandbox-assertion.config';

/**
 * Resolves the sandbox allowlist from the process environment on every call.
 *
 * Reading per call rather than caching at construction keeps the behaviour
 * predictable in tests, which set and restore environment variables around
 * individual cases, and costs nothing on a route that is not on the hot path.
 */
export class EnvSandboxAssertionPolicy implements SandboxAssertionPolicyPort {
  /**
   * Both halves must be present. An allowlist without a key would accept the
   * request and then fail to sign it, and a key without an allowlist has
   * nobody entitled to use it.
   */
  isEnabled(): boolean {
    return (
      readSandboxOrganizationIds().length > 0 &&
      readSandboxSigningMaterial() !== undefined
    );
  }

  allows(organizationId: string): boolean {
    return (
      this.isEnabled() && readSandboxOrganizationIds().includes(organizationId)
    );
  }

  isConfiguredOrganization(organizationId: string): boolean {
    return readSandboxOrganizationIds().includes(organizationId);
  }
}

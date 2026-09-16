import type { SandboxAssertionPolicyPort } from '../application/sandbox-assertion-policy.port';
import { readSandboxAssertionConfig } from './sandbox-assertion.config';

/**
 * Resolves the sandbox allowlist from the process environment on every call.
 *
 * Reading per call rather than caching at construction keeps the behaviour
 * predictable in tests, which set and restore environment variables around
 * individual cases, and costs nothing on a route that is not on the hot path.
 */
export class EnvSandboxAssertionPolicy implements SandboxAssertionPolicyPort {
  isEnabled(): boolean {
    return readSandboxAssertionConfig() !== undefined;
  }

  allows(organizationId: string): boolean {
    return (
      readSandboxAssertionConfig()?.organizationIds.includes(organizationId) ===
      true
    );
  }
}

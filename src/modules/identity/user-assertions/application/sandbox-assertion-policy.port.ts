/**
 * Decides whether sandbox minting is available at all, and which organizations
 * may use it.
 *
 * This is a port rather than a direct configuration read so that the guard
 * enforcing it stays in the presentation layer without reaching into
 * infrastructure. It also keeps the decision testable without an environment.
 */
export interface SandboxAssertionPolicyPort {
  /**
   * `false` when this deployment has no sandbox configured. The boundary turns
   * that into a 404: a deployment without a sandbox should be
   * indistinguishable from a build that never had the route.
   */
  isEnabled(): boolean;

  allows(organizationId: string): boolean;

  /** Identifies the operator-configured demo Organization without signing material. */
  isConfiguredOrganization?(organizationId: string): boolean;
}

export const SANDBOX_ASSERTION_POLICY = Symbol('SANDBOX_ASSERTION_POLICY');

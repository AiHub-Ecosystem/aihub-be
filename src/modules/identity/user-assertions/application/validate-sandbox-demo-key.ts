import type {
  SandboxDemoEnvironment,
  SandboxDemoScope,
  SandboxDemoUserIdentityMode,
} from '@/contracts/sandbox/demo-key-validation';
import type {
  SandboxAllowanceSnapshot,
  SandboxDispatchBudgetPort,
} from '@/modules/gateway/public/sandbox-dispatch-budget';
import { forbidden } from '@/modules/identity/membership/application/organization-membership.authorization';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { identityProviderUnavailable } from './user-identity-errors';

/** Same Safe Authorization Denial the guards give, message included. */
const NOT_AUTHORIZED = 'API key is not authorized for this operation';

export interface ValidateSandboxDemoKeyInput {
  readonly organizationId: string;
  /** The environment the demo page selected. */
  readonly environment: SandboxDemoEnvironment;
  /** The environment resolved from the AIHUB host serving this request. */
  readonly authenticatedEnvironment: string;
  /** The environments the key is durably bound to; the prefix is irrelevant. */
  readonly allowedEnvironments: readonly string[];
  readonly scope: SandboxDemoScope;
  /** Scopes the authenticated API key carries. */
  readonly grantedScopes: readonly string[];
}

export interface SandboxDemoKeyEligibility {
  readonly valid: true;
  readonly environment: SandboxDemoEnvironment;
  readonly scope: SandboxDemoScope;
  readonly userIdentityMode: SandboxDemoUserIdentityMode;
  /** null in Production, and in Sandbox when policy state cannot be read. */
  readonly allowance: SandboxAllowanceSnapshot | null;
}

/**
 * Decides whether an authenticated customer key may grade the selected
 * environment and scope.
 *
 * The selected environment is checked against the key's stored binding and its
 * prefix against nothing: the database is the only authority. An active Identity
 * Configuration no longer refuses the key; it selects which user-identity input
 * the demo collects next. That signal authorizes nothing: every identity-scoped
 * upload and grading call re-reads the configuration and verifies the supplied
 * assertion itself, and an unreadable configuration fails closed as retryable
 * rather than falling back to `declared_id`. The repositories are reached here,
 * in the application layer, so the lookups and the translation of a persistence
 * failure stay out of the controller.
 *
 * Nothing here dispatches: the only budget call is the read that reports a
 * current allowance, and it reserves nothing.
 */
export class ValidateSandboxDemoKey {
  constructor(
    private readonly identityConfig: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'findActiveByOrganizationId'
    >,
    private readonly budget: Pick<SandboxDispatchBudgetPort, 'allowanceFor'>,
  ) {}

  async validate(
    input: ValidateSandboxDemoKeyInput,
  ): Promise<SandboxDemoKeyEligibility> {
    if (
      input.authenticatedEnvironment !== input.environment ||
      !input.allowedEnvironments.includes(input.environment)
    ) {
      throw forbidden(NOT_AUTHORIZED);
    }
    if (!input.grantedScopes.includes(input.scope)) {
      throw forbidden(NOT_AUTHORIZED);
    }

    let configured: OrganizationIdentityConfig | null;
    try {
      configured = await this.identityConfig.findActiveByOrganizationId(
        input.organizationId,
      );
    } catch (error) {
      throw identityProviderUnavailable(error);
    }

    return {
      valid: true,
      environment: input.environment,
      scope: input.scope,
      userIdentityMode:
        configured === null ? 'declared_id' : 'signed_assertion',
      allowance:
        input.environment === 'sandbox'
          ? await this.budget.allowanceFor(input.organizationId)
          : null,
    };
  }
}

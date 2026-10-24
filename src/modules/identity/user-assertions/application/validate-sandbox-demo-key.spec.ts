import { getMetrics } from '@/common/observability/metrics';
import type {
  SandboxAllowanceSnapshot,
  SandboxDispatchBudgetPort,
} from '@/modules/gateway/public/sandbox-dispatch-budget';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { ValidateSandboxDemoKey } from './validate-sandbox-demo-key';

const CONFIG = { organizationId: 'org_demo' } as OrganizationIdentityConfig;

async function rejectedAuthCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="auth"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

function validator(
  find: OrganizationIdentityConfigRepositoryPort['findActiveByOrganizationId'],
  allowance: SandboxAllowanceSnapshot | null = {
    monthlyLimit: 5,
    reserved: 1,
    sharedMonthlyLimit: 500,
    sharedReserved: 12,
  },
): ValidateSandboxDemoKey {
  const budget: SandboxDispatchBudgetPort = {
    // Validation reserves nothing, so a reservation here is a test failure.
    reserve: async () => {
      throw new Error('validation must never reserve a dispatch');
    },
    release: async () => undefined,
    allowanceFor: async () => allowance,
  };

  return new ValidateSandboxDemoKey(
    { findActiveByOrganizationId: find },
    budget,
  );
}

function validate(
  useCase: ValidateSandboxDemoKey,
  overrides: Partial<Parameters<ValidateSandboxDemoKey['validate']>[0]> = {},
) {
  return useCase.validate({
    organizationId: 'org_demo',
    environment: 'sandbox',
    authenticatedEnvironment: 'sandbox',
    allowedEnvironments: ['sandbox'],
    scope: 'speaking.grade',
    grantedScopes: ['writing.grade', 'speaking.grade'],
    ...overrides,
  });
}

describe('ValidateSandboxDemoKey', () => {
  // A disabled configuration is absent from the active lookup, which filters on
  // persisted status, so absent and disabled share this one outcome.
  it('admits the selected environment and scope and reports the Sandbox allowance', async () => {
    await expect(
      validator(async () => null).validate({
        organizationId: 'org_demo',
        environment: 'sandbox',
        authenticatedEnvironment: 'sandbox',
        allowedEnvironments: ['sandbox'],
        scope: 'speaking.grade',
        grantedScopes: ['writing.grade', 'speaking.grade'],
      }),
    ).resolves.toEqual({
      valid: true,
      environment: 'sandbox',
      scope: 'speaking.grade',
      userIdentityMode: 'declared_id',
      allowance: {
        monthlyLimit: 5,
        reserved: 1,
        sharedMonthlyLimit: 500,
        sharedReserved: 12,
      },
    });
  });

  it('admits a Production selection for a key bound to Production and reports no Sandbox allowance', async () => {
    await expect(
      validate(
        validator(async () => null),
        {
          environment: 'production',
          authenticatedEnvironment: 'production',
          allowedEnvironments: ['production'],
        },
      ),
    ).resolves.toEqual({
      valid: true,
      environment: 'production',
      scope: 'speaking.grade',
      userIdentityMode: 'declared_id',
      allowance: null,
    });
  });

  it('refuses a selection the key is not stored for', async () => {
    const before = await rejectedAuthCount();
    await expect(
      validate(
        validator(async () => null),
        { environment: 'production' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it('refuses a selection that does not match the authenticated host', async () => {
    const before = await rejectedAuthCount();
    await expect(
      validate(
        validator(async () => null),
        {
          environment: 'production',
          authenticatedEnvironment: 'sandbox',
          allowedEnvironments: ['production'],
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await rejectedAuthCount()).toBe(before);
  });

  it('admits a legacy key whose stored environments include the selection', async () => {
    await expect(
      validate(
        validator(async () => null),
        {
          allowedEnvironments: ['staging', 'sandbox', 'production'],
        },
      ),
    ).resolves.toMatchObject({ valid: true });
  });

  it('refuses a scope the key does not carry', async () => {
    const before = await rejectedAuthCount();
    await expect(
      validate(
        validator(async () => null),
        {
          scope: 'writing.grade',
          grantedScopes: ['writing.grade'],
        },
      ),
    ).resolves.toMatchObject({ valid: true });
    await expect(
      validate(
        validator(async () => null),
        {
          scope: 'speaking.grade',
          grantedScopes: ['writing.grade'],
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it('admits an Organization with an active Identity Configuration and reports signed assertion', async () => {
    await expect(
      validate(
        validator(async () => CONFIG),
        {
          scope: 'writing.grade',
          grantedScopes: ['writing.grade'],
        },
      ),
    ).resolves.toMatchObject({
      valid: true,
      userIdentityMode: 'signed_assertion',
    });
  });

  it('admits a Production selection for an Organization with active Identity Configuration', async () => {
    await expect(
      validate(
        validator(async () => CONFIG),
        {
          environment: 'production',
          authenticatedEnvironment: 'production',
          allowedEnvironments: ['production'],
        },
      ),
    ).resolves.toMatchObject({
      valid: true,
      environment: 'production',
      userIdentityMode: 'signed_assertion',
    });
  });

  it('reports an unreadable allowance as absent rather than as a default', async () => {
    await expect(
      validate(validator(async () => null, null)),
    ).resolves.toMatchObject({ allowance: null });
  });

  it('reports an unreachable control plane as retryable, never as a refusal', async () => {
    await expect(
      validator(async () => {
        throw new Error('connection terminated');
      }).validate({
        organizationId: 'org_demo',
        environment: 'sandbox',
        authenticatedEnvironment: 'sandbox',
        allowedEnvironments: ['sandbox'],
        scope: 'writing.grade',
        grantedScopes: ['writing.grade'],
      }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('reports an unreachable control plane the same way for a Production selection', async () => {
    await expect(
      validate(
        validator(async () => {
          throw new Error('connection terminated');
        }),
        {
          environment: 'production',
          authenticatedEnvironment: 'production',
          allowedEnvironments: ['production'],
        },
      ),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});

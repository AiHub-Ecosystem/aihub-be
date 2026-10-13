import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { ValidateSandboxDemoKey } from './validate-sandbox-demo-key';

const CONFIG = { organizationId: 'org_demo' } as OrganizationIdentityConfig;

function validator(
  find: OrganizationIdentityConfigRepositoryPort['findActiveByOrganizationId'],
): ValidateSandboxDemoKey {
  return new ValidateSandboxDemoKey({ findActiveByOrganizationId: find });
}

describe('ValidateSandboxDemoKey', () => {
  it('admits a scope the key carries when no identity is configured', async () => {
    const result = await validator(async () => null).validate({
      organizationId: 'org_demo',
      scope: 'speaking.grade',
      grantedScopes: ['writing.grade', 'speaking.grade'],
    });

    expect(result).toEqual({ valid: true });
  });

  it('refuses a scope the key does not carry', async () => {
    await expect(
      validator(async () => null).validate({
        organizationId: 'org_demo',
        scope: 'speaking.grade',
        grantedScopes: ['writing.grade'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an Organization with an active Identity Configuration', async () => {
    await expect(
      validator(async () => CONFIG).validate({
        organizationId: 'org_demo',
        scope: 'writing.grade',
        grantedScopes: ['writing.grade'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports an unreachable control plane as retryable, never as a refusal', async () => {
    await expect(
      validator(async () => {
        throw new Error('connection terminated');
      }).validate({
        organizationId: 'org_demo',
        scope: 'writing.grade',
        grantedScopes: ['writing.grade'],
      }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});

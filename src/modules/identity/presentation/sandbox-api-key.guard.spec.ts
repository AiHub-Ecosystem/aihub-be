import type { ExecutionContext } from '@nestjs/common';

import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '../application/api-key-authenticator.port';
import type { SandboxAssertionPolicyPort } from '../application/sandbox-assertion-policy.port';
import { SandboxApiKeyGuard } from './sandbox-api-key.guard';

const authenticated: AuthenticatedApiKey = {
  organizationId: 'org_sandbox',
  apiKeyId: 'ak_sandbox',
  environment: 'production',
  scopes: ['speaking.grade'],
  rateLimitRpm: 60,
  maxConcurrent: 3,
  monthlyRequestQuota: 500,
  hardStopOnQuota: true,
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    headers: { 'x-api-key': 'aihub_sk_value' },
    hostname: 'api.aihub.test',
    ip: '203.0.113.7',
    ...overrides,
  };
}

function context(value: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => value }),
  } as unknown as ExecutionContext;
}

function policy(
  overrides: Partial<SandboxAssertionPolicyPort> = {},
): SandboxAssertionPolicyPort {
  return {
    isEnabled: () => true,
    allows: (organizationId) => organizationId === 'org_sandbox',
    ...overrides,
  };
}

function guard(
  options: {
    readonly policy?: SandboxAssertionPolicyPort;
    readonly authenticator?: ApiKeyAuthenticatorPort;
  } = {},
) {
  return new SandboxApiKeyGuard(
    options.authenticator ?? { authenticate: async () => authenticated },
    options.policy ?? policy(),
  );
}

describe('SandboxApiKeyGuard', () => {
  const originalHost = process.env.AIHUB_PRODUCTION_HOST;

  beforeEach(() => {
    process.env.AIHUB_PRODUCTION_HOST = 'api.aihub.test';
  });

  afterEach(() => {
    process.env.AIHUB_PRODUCTION_HOST = originalHost;
  });

  it('authenticates a sandbox key and exposes it on the request', async () => {
    const value = request();

    await expect(guard().canActivate(context(value))).resolves.toBe(true);
    expect(value).toMatchObject({ aihubAuth: authenticated });
  });

  // A deployment without a sandbox should look like a build that never had
  // the route, rather than advertising a feature it will not perform.
  it('answers NOT_FOUND when no sandbox is configured', async () => {
    await expect(
      guard({ policy: policy({ isEnabled: () => false }) }).canActivate(
        context(request()),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a valid key belonging to an organization outside the allowlist', async () => {
    const value = request();

    await expect(
      guard({
        authenticator: {
          authenticate: async () => ({
            ...authenticated,
            organizationId: 'org_acme',
          }),
        },
      }).canActivate(context(value)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(value).not.toHaveProperty('aihubAuth');
  });

  it('lets an authentication failure surface unchanged', async () => {
    await expect(
      guard({
        authenticator: {
          authenticate: async () => {
            throw Object.assign(new Error('nope'), { code: 'UNAUTHORIZED' });
          },
        },
      }).canActivate(context(request())),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a host that is not bound to an environment', async () => {
    await expect(
      guard().canActivate(context(request({ hostname: 'evil.example.com' }))),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_ALLOWED' });
  });
});

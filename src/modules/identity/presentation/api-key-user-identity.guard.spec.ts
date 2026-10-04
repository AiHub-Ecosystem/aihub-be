import type { ExecutionContext } from '@nestjs/common';

import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '@/modules/identity/application/api-key-authenticator.port';
import type {
  ResolvedUserIdentity,
  UserIdentityInput,
  UserIdentityResolverPort,
} from '@/modules/identity/application/user-identity-resolver.port';

import { ApiKeyUserIdentityGuard } from './api-key-user-identity.guard';

const authenticated: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['speaking.grade'],
  rateLimitRpm: 60,
  maxConcurrent: 3,
  monthlyRequestQuota: 500,
  hardStopOnQuota: true,
};

const resolved: ResolvedUserIdentity = {
  userId: 'student-123',
  organizationId: 'org_acme',
  scopes: [],
};

function request(headers: Record<string, unknown> = {}) {
  return {
    headers: {
      'x-api-key': 'aihub_sk_value',
      'x-user-identity': 'student-123',
      ...headers,
    },
    hostname: 'api.acme-real-domain.com',
    ip: '203.0.113.7',
  };
}

function context(value: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => value }),
  } as unknown as ExecutionContext;
}

function guard(
  options: {
    readonly authenticator?: ApiKeyAuthenticatorPort;
    readonly resolver?: UserIdentityResolverPort;
  } = {},
) {
  return new ApiKeyUserIdentityGuard(
    options.authenticator ?? { authenticate: async () => authenticated },
    options.resolver ?? { resolve: async () => resolved },
  );
}

describe('ApiKeyUserIdentityGuard', () => {
  const originalHost = process.env.AIHUB_PRODUCTION_HOST;

  beforeEach(() => {
    process.env.AIHUB_PRODUCTION_HOST = 'api.acme-real-domain.com';
  });

  afterEach(() => {
    if (originalHost === undefined) {
      Reflect.deleteProperty(process.env, 'AIHUB_PRODUCTION_HOST');
    } else {
      process.env.AIHUB_PRODUCTION_HOST = originalHost;
    }
  });

  it('attaches the resolved End-User ID to the authenticated request', async () => {
    const value = request();

    await expect(guard().canActivate(context(value))).resolves.toBe(true);
    expect(value).toMatchObject({
      aihubAuth: authenticated,
      aihubIdentity: resolved,
    });
  });

  it('resolves the identity against the authenticated Organization', async () => {
    const inputs: UserIdentityInput[] = [];
    const value = request();

    await guard({
      resolver: {
        resolve: async (input) => {
          inputs.push(input);
          return resolved;
        },
      },
    }).canActivate(context(value));

    expect(inputs).toEqual([
      { value: 'student-123', organizationId: 'org_acme' },
    ]);
  });

  it('refuses a request with no X-User-Identity header', async () => {
    await expect(
      guard().canActivate(context(request({ 'x-user-identity': undefined }))),
    ).rejects.toMatchObject({ code: 'USER_IDENTITY_REQUIRED' });
  });

  it('refuses an X-User-Identity that is not a usable string', async () => {
    await expect(
      guard().canActivate(context(request({ 'x-user-identity': '   ' }))),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });

    await expect(
      guard().canActivate(
        context(request({ 'x-user-identity': ['student-123'] })),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
  });

  // The resolver trusts its caller to pass the right Organization. A signed
  // assertion minted for another tenant would otherwise resolve successfully
  // and let one Organization record another tenant's End-User ID.
  it('refuses an identity that resolves to another Organization', async () => {
    const value = request();

    await expect(
      guard({
        resolver: {
          resolve: async () => ({
            ...resolved,
            organizationId: 'org_other',
          }),
        },
      }).canActivate(context(value)),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    expect(value).not.toHaveProperty('aihubIdentity');
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

  it('lets an identity-provider outage surface as retryable', async () => {
    await expect(
      guard({
        resolver: {
          resolve: async () => {
            throw Object.assign(new Error('jwks'), {
              code: 'IDENTITY_PROVIDER_UNAVAILABLE',
              retryable: true,
            });
          },
        },
      }).canActivate(context(request())),
    ).rejects.toMatchObject({ code: 'IDENTITY_PROVIDER_UNAVAILABLE' });
  });
});

import type { ExecutionContext } from '@nestjs/common';

import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { UserIdentityResolverPort } from '@/modules/identity/user-assertions/application/user-identity-resolver.port';
import type { RequestEnvironmentConfig } from './request-environment';
import { UserIdentityGuard } from './user-identity.guard';

const authenticated: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function guard(
  operation: string,
  resolver: UserIdentityResolverPort = {
    resolve: async () => ({
      userId: 'user_123',
      organizationId: 'org_acme',
      scopes: [],
    }),
  },
  configuration: RequestEnvironmentConfig = {
    NODE_ENV: 'production',
    AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
    AIHUB_PRODUCTION_HOST: undefined,
    AIHUB_STAGING_HOST: undefined,
    AIHUB_DEVELOPMENT_HOST: undefined,
    AIHUB_SANDBOX_HOST: undefined,
  },
) {
  return new UserIdentityGuard(
    { getAllAndOverride: () => operation } as never,
    resolver,
    configuration,
  );
}

describe('UserIdentityGuard', () => {
  it('rejects a missing user identity for user-scoped operations', async () => {
    const request: Record<string, unknown> = {
      headers: {},
      aihubAuth: authenticated,
    };

    await expect(
      guard('writing.task1.grade').canActivate(context(request)),
    ).rejects.toMatchObject({
      code: 'USER_IDENTITY_REQUIRED',
      httpStatus: 401,
    });
  });

  it('uses the synthetic actor only for the local development bypass', async () => {
    const request: Record<string, unknown> = {
      headers: {},
      aihubAuth: { ...authenticated, organizationId: 'local-development' },
    };

    await expect(
      guard('writing.task1.grade', undefined, {
        NODE_ENV: 'test',
        AIHUB_ALLOW_UNAUTHENTICATED_DEV: true,
        AIHUB_PRODUCTION_HOST: undefined,
        AIHUB_STAGING_HOST: undefined,
        AIHUB_DEVELOPMENT_HOST: undefined,
        AIHUB_SANDBOX_HOST: undefined,
      }).canActivate(context(request)),
    ).resolves.toBe(true);
    expect(request.aihubIdentity).toEqual({
      userId: 'local-development',
      organizationId: 'local-development',
      scopes: [],
    });
  });

  it('rejects a blank user identity instead of treating it as missing', async () => {
    const request: Record<string, unknown> = {
      headers: { 'x-user-identity': '   ' },
      aihubAuth: authenticated,
    };

    await expect(
      guard('writing.task1.grade').canActivate(context(request)),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY', httpStatus: 401 });
    expect(request.aihubIdentity).toBeUndefined();
  });
});

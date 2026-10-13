import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { WebSessionClientSecretPort } from '@/modules/auth/application/web-session-client-secret.port';
import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { RequestEnvironmentConfig } from '@/modules/identity/shared/presentation/request-environment';
import { ApiKeyGuard } from './api-key.guard';

// writing.task1.grade requires the `writing.grade` Scope.
const OPERATION_ID = 'writing.task1.grade';
const requiredScope = 'writing.grade';

const baseKey: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_01',
  environment: 'production',
  scopes: [requiredScope],
  rateLimitRpm: 60,
  maxConcurrent: 3,
  monthlyRequestQuota: 500,
  hardStopOnQuota: true,
  allowedEnvironments: ['production'],
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    headers: { host: 'api.aihub.test', 'x-api-key': 'aihub_sk_value' },
    hostname: 'api.aihub.test',
    ip: '203.0.113.7',
    ...overrides,
  };
}

function context(value: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => value }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function reflector(): Reflector {
  return {
    getAllAndOverride: () => OPERATION_ID,
  } as unknown as Reflector;
}

function guard(
  authenticator: ApiKeyAuthenticatorPort,
  secret?: WebSessionClientSecretPort,
): ApiKeyGuard {
  return new ApiKeyGuard(
    reflector(),
    authenticator,
    {
      NODE_ENV: 'test',
      AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
      AIHUB_PRODUCTION_HOST: 'api.aihub.test',
      AIHUB_STAGING_HOST: undefined,
      AIHUB_DEVELOPMENT_HOST: undefined,
      AIHUB_SANDBOX_HOST: 'sandbox.aihub.test',
    } satisfies RequestEnvironmentConfig,
    secret,
  );
}

describe('ApiKeyGuard scope check', () => {
  it('admits a key whose Scopes cover the operation requiredScope', async () => {
    const value = request();

    await expect(
      guard({ authenticate: async () => baseKey }).canActivate(context(value)),
    ).resolves.toBe(true);
  });

  it('keeps a legacy key eligible for Sandbox when the stored binding includes it', async () => {
    const value = request({
      headers: {
        host: 'sandbox.aihub.test',
        'x-api-key': 'aihub_sk_value',
      },
      hostname: 'sandbox.aihub.test',
    });
    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async () => ({
        ...baseKey,
        environment: 'sandbox',
        allowedEnvironments: ['sandbox', 'production'],
      }),
    };

    await expect(
      guard(authenticator).canActivate(context(value)),
    ).resolves.toBe(true);
  });

  it('uses the trusted visitor IP for authenticated demo BFF grading', async () => {
    let credentials: { clientIp: string; forceFresh?: boolean } | undefined;
    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async (input) => {
        credentials = input;
        return baseKey;
      },
    };
    const value = request({
      headers: {
        host: 'api.aihub.test',
        'x-api-key': 'aihub_sk_value',
        'x-aihub-client-secret': 'bff-secret',
        'x-aihub-visitor-ip': '203.0.113.25',
      },
    });

    await expect(
      guard(authenticator, { resolve: () => 'bff-secret' }).canActivate(
        context(value),
      ),
    ).resolves.toBe(true);
    expect(credentials).toMatchObject({
      clientIp: '203.0.113.25',
      forceFresh: true,
    });
    expect(value).toMatchObject({ aihubClientIpSource: 'customer_web_bff' });
  });

  it('rejects a forged BFF secret before API-key authentication', async () => {
    const authenticate = jest.fn(async () => baseKey);
    const value = request({
      headers: {
        host: 'api.aihub.test',
        'x-api-key': 'aihub_sk_value',
        'x-aihub-client-secret': 'wrong',
        'x-aihub-visitor-ip': '203.0.113.25',
      },
    });

    await expect(
      guard({ authenticate }, { resolve: () => 'bff-secret' }).canActivate(
        context(value),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('refuses a key without the operation requiredScope', async () => {
    await expect(
      guard({
        authenticate: async () => ({ ...baseKey, scopes: ['speaking.grade'] }),
        // `speaking.grade` does not cover `writing.task1.grade`.
      }).canActivate(context(request())),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

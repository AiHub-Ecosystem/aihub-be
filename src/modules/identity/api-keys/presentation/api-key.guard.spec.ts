import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { AppError } from '@/common/errors/app-error';
import { getMetrics } from '@/common/observability/metrics';
import type { WebSessionClientSecretPort } from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { RequestEnvironmentConfig } from '@/modules/identity/shared/presentation/request-environment';
import {
  ADDITIONAL_OPERATION_SCOPES_METADATA,
  REQUIRED_OPERATION_METADATA,
} from '@/modules/identity/shared/presentation/require-operation.decorator';
import { ApiKeyGuard } from './api-key.guard';

// writing.task1.grade requires the `writing.grade` Scope.
const OPERATION_ID = 'writing.task1.grade';
const requiredScope = 'writing.grade';

async function rejectedAuthCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="auth"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

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

function reflector(additionalScopes: readonly string[] = []): Reflector {
  return {
    getAllAndOverride: (metadataKey: string) =>
      metadataKey === REQUIRED_OPERATION_METADATA
        ? OPERATION_ID
        : metadataKey === ADDITIONAL_OPERATION_SCOPES_METADATA
          ? additionalScopes
          : undefined,
  } as unknown as Reflector;
}

function guard(
  authenticator: ApiKeyAuthenticatorPort,
  secret?: WebSessionClientSecretPort,
  additionalScopes: readonly string[] = [],
  configOverrides: Partial<RequestEnvironmentConfig> = {},
): ApiKeyGuard {
  return new ApiKeyGuard(
    reflector(additionalScopes),
    authenticator,
    {
      NODE_ENV: 'test',
      AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
      AIHUB_PRODUCTION_HOST: 'api.aihub.test',
      AIHUB_STAGING_HOST: undefined,
      AIHUB_DEVELOPMENT_HOST: undefined,
      AIHUB_SANDBOX_HOST: 'sandbox.aihub.test',
      AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
      ...configOverrides,
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

  it('admits a Writing exercise key for a route that accepts it as an alternate scope', async () => {
    const value = request();

    await expect(
      guard(
        {
          authenticate: async () => ({
            ...baseKey,
            scopes: ['writing.exercise'],
          }),
        },
        undefined,
        ['writing.exercise'],
      ).canActivate(context(value)),
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
      guard(authenticator, undefined, [], {
        AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
      }).canActivate(context(value)),
    ).resolves.toBe(true);
  });

  it('refuses a Sandbox request sent to the Production deployment before authentication', async () => {
    const authenticate = jest.fn();
    const value = request({
      headers: {
        host: 'sandbox.aihub.test',
        'x-api-key': 'aihub_sk_value',
      },
      hostname: 'sandbox.aihub.test',
    });

    await expect(
      guard({ authenticate }, undefined, [], {
        AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
        AIHUB_SANDBOX_HOST: 'sandbox.aihub.test',
      }).canActivate(context(value)),
    ).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_ALLOWED',
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(value).not.toHaveProperty('aihubAuth');
    expect(value).not.toHaveProperty('aihubMeteringEvidence');
  });

  it('refuses a Production request sent to the Sandbox deployment before authentication', async () => {
    const authenticate = jest.fn();
    const value = request({
      headers: {
        host: 'api.aihub.test',
        'x-api-key': 'aihub_sk_value',
      },
      hostname: 'api.aihub.test',
    });

    await expect(
      guard({ authenticate }, undefined, [], {
        AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
        AIHUB_PRODUCTION_HOST: 'api.aihub.test',
        AIHUB_SANDBOX_HOST: 'sandbox.aihub.test',
      }).canActivate(context(value)),
    ).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_ALLOWED',
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(value).not.toHaveProperty('aihubAuth');
    expect(value).not.toHaveProperty('aihubMeteringEvidence');
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
    const before = await rejectedAuthCount();
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
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it('logs the failing stage for internal errors without logging error contents', async () => {
    const logError = jest.fn();
    const internalError = new AppError({
      code: 'INTERNAL_ERROR',
      message: 'private error detail',
      retryable: false,
    });
    const value = request({
      id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      headers: {
        host: 'api.aihub.test',
        'x-api-key': 'aihub_sk_value',
        'x-correlation-id': 'req_123e4567-e89b-42d3-a456-426614174000',
      },
      log: { error: logError },
    });

    await expect(
      guard({
        authenticate: async () => {
          throw internalError;
        },
      }).canActivate(context(value)),
    ).rejects.toBe(internalError);

    expect(logError).toHaveBeenCalledWith({
      event: 'api_key_guard_internal_error',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      correlation_id: 'req_123e4567-e89b-42d3-a456-426614174000',
      stage: 'api_key_authentication',
      error_type: 'AppError',
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain(
      'private error detail',
    );
  });

  it('logs a safe reason when a BFF request omits its visitor IP', async () => {
    const logError = jest.fn();
    const value = request({
      headers: {
        host: 'api.aihub.test',
        'x-api-key': 'aihub_sk_value',
        'x-aihub-client-secret': 'bff-secret',
      },
      log: { error: logError },
    });

    await expect(
      guard(
        { authenticate: jest.fn(async () => baseKey) },
        {
          resolve: () => 'bff-secret',
        },
      ).canActivate(context(value)),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'bff_authentication',
        error_diagnostic: 'bff-visitor-ip-missing-or-invalid',
      }),
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain('bff-secret');
  });

  it('refuses a key without the operation requiredScope', async () => {
    const before = await rejectedAuthCount();
    await expect(
      guard({
        authenticate: async () => ({ ...baseKey, scopes: ['speaking.grade'] }),
        // `speaking.grade` does not cover `writing.task1.grade`.
      }).canActivate(context(request())),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await rejectedAuthCount()).toBe(before + 1);
  });
});

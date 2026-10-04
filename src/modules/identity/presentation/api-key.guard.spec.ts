import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '@/modules/identity/application/api-key-authenticator.port';
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
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function reflector(): Reflector {
  return {
    getAllAndOverride: () => OPERATION_ID,
  } as unknown as Reflector;
}

function guard(authenticator: ApiKeyAuthenticatorPort): ApiKeyGuard {
  return new ApiKeyGuard(reflector(), authenticator, undefined);
}

describe('ApiKeyGuard scope check', () => {
  const originalHost = process.env.AIHUB_PRODUCTION_HOST;

  beforeEach(() => {
    process.env.AIHUB_PRODUCTION_HOST = 'api.aihub.test';
  });

  afterEach(() => {
    if (originalHost === undefined) {
      Reflect.deleteProperty(process.env, 'AIHUB_PRODUCTION_HOST');
    } else {
      process.env.AIHUB_PRODUCTION_HOST = originalHost;
    }
  });

  it('admits a key whose Scopes cover the operation requiredScope', async () => {
    const value = request();

    await expect(
      guard({ authenticate: async () => baseKey }).canActivate(context(value)),
    ).resolves.toBe(true);
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

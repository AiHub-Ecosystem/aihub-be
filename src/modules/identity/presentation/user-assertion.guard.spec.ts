import type { ExecutionContext } from '@nestjs/common';

import type { AuthenticatedApiKey } from '../application/api-key-authenticator.port';
import type { UserAssertionVerifierPort } from '../application/user-assertion-verifier.port';
import { UserAssertionGuard } from './user-assertion.guard';

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
  verifier: UserAssertionVerifierPort = {
    verify: async () => ({
      userId: 'user_123',
      organizationId: 'org_acme',
      scopes: [],
    }),
  },
) {
  return new UserAssertionGuard(
    { getAllAndOverride: () => operation } as never,
    verifier,
  );
}

describe('UserAssertionGuard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBypass = process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalBypass;
  });

  it('rejects a missing assertion for user-scoped operations', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'false';
    const request: Record<string, unknown> = {
      headers: {},
      aihubAuth: authenticated,
    };

    await expect(
      guard('writing.task1.grade').canActivate(context(request)),
    ).rejects.toMatchObject({
      code: 'USER_ASSERTION_REQUIRED',
      httpStatus: 401,
    });
  });

  it('allows organization-scoped requests without an assertion', async () => {
    const request: Record<string, unknown> = {
      headers: {},
      aihubAuth: authenticated,
    };

    await expect(
      guard('writing.task1.question.generate').canActivate(context(request)),
    ).resolves.toBe(true);
    expect(request.aihubIdentity).toBeUndefined();
  });

  it('verifies and attaches a supplied assertion even for organization scope', async () => {
    const calls: string[] = [];
    const verifier: UserAssertionVerifierPort = {
      verify: async (input) => {
        calls.push(input.signedAssertion);
        return {
          userId: 'user_123',
          organizationId: input.organizationId,
          scopes: [],
        };
      },
    };
    const request: Record<string, unknown> = {
      headers: { 'x-user-assertion': 'signed.assertion' },
      aihubAuth: authenticated,
    };

    await expect(
      guard('writing.task1.question.generate', verifier).canActivate(
        context(request),
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual(['signed.assertion']);
    expect(request.aihubIdentity).toEqual({
      userId: 'user_123',
      organizationId: 'org_acme',
      scopes: [],
    });
  });

  it('uses the synthetic actor only for the local development bypass', async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    const request: Record<string, unknown> = {
      headers: {},
      aihubAuth: { ...authenticated, organizationId: 'local-development' },
    };

    await expect(
      guard('writing.task1.grade').canActivate(context(request)),
    ).resolves.toBe(true);
    expect(request.aihubIdentity).toEqual({
      userId: 'local-development',
      organizationId: 'local-development',
      scopes: [],
    });
  });
});

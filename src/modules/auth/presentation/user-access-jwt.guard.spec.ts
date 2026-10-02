import type { ExecutionContext } from '@nestjs/common';

import type {
  UserAccessTokenVerifierPort,
  VerifiedUserAccessToken,
} from '@/modules/auth/application/user-access-token.port';
import {
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { UserAccessJwtGuard } from './user-access-jwt.guard';

function context(
  request: Record<string, unknown>,
  response: { header: jest.Mock } = { header: jest.fn() },
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('UserAccessJwtGuard', () => {
  const verified: VerifiedUserAccessToken = {
    userId: 'usr_01J00000000000000000000000',
    jti: 'jti_01',
  };

  /** The guard reads the account status, so the case composes that adapter. */
  function makeGuard(
    verifier: UserAccessTokenVerifierPort = { verify: async () => verified },
    status: 'active' | 'disabled' = 'active',
  ): UserAccessJwtGuard {
    const state = createInMemoryAuthState();
    seedAccount(state, {
      userId: verified.userId,
      email: 'person@example.com',
      passwordHash: '$argon2id$fake',
      status,
    });
    return new UserAccessJwtGuard(
      verifier,
      new InMemoryUserAccountAdapter(state),
    );
  }

  it('accepts exactly one case-insensitive bearer token and stores only user identity', async () => {
    const request: Record<string, unknown> = {
      headers: { authorization: 'bEaReR compact.token.value' },
    };
    const guard = makeGuard();

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.aihubUser).toEqual({ userId: verified.userId });
  });

  it.each<[string, { readonly authorization?: string | string[] }]>([
    ['missing', {}],
    ['duplicate', { authorization: ['Bearer one', 'Bearer two'] }],
    ['wrong scheme', { authorization: 'Basic compact.token.value' }],
    ['extra token', { authorization: 'Bearer one.two.three four' }],
  ])(
    'rejects %s with the correct generic boundary error',
    async (_label, headers) => {
      const response = { header: jest.fn() };
      const guard = makeGuard();

      await expect(
        guard.canActivate(context({ headers }, response)),
      ).rejects.toMatchObject({
        code:
          headers.authorization === undefined
            ? 'AUTH_USER_ACCESS_TOKEN_REQUIRED'
            : 'AUTH_USER_ACCESS_TOKEN_INVALID',
        httpStatus: 401,
      });
      expect(response.header).toHaveBeenCalledWith(
        'WWW-Authenticate',
        'Bearer',
      );
    },
  );

  it.each([
    ['query', { query: { access_token: 'compact.token.value' } }],
    ['cookie', { cookies: { access_token: 'compact.token.value' } }],
  ])('rejects a %s token source', async (_label, source) => {
    const response = { header: jest.fn() };
    const guard = makeGuard();

    await expect(
      guard.canActivate(
        context(
          {
            headers: { authorization: 'Bearer compact.token.value' },
            ...source,
          },
          response,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
      httpStatus: 401,
    });
    expect(response.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
  });

  it('rejects a validly signed token when the durable account is no longer active', async () => {
    const guard = makeGuard(undefined, 'disabled');

    await expect(
      guard.canActivate(
        context({ headers: { authorization: 'Bearer compact.token.value' } }),
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
      httpStatus: 401,
    });
  });

  it('rejects a validly signed token whose account no longer exists', async () => {
    const state = createInMemoryAuthState();
    const guard = new UserAccessJwtGuard(
      { verify: async () => verified },
      new InMemoryUserAccountAdapter(state),
    );

    await expect(
      guard.canActivate(
        context({ headers: { authorization: 'Bearer compact.token.value' } }),
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
      httpStatus: 401,
    });
  });
});

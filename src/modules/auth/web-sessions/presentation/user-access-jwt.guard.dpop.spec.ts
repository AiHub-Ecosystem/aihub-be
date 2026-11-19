import type { ExecutionContext } from '@nestjs/common';

import { invalidUserAccessToken } from '@/modules/auth/shared/application/local-auth-errors';
import {
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccessTokenRevocationAdapter } from '@/modules/auth/testing/in-memory-user-access-token-revocation.adapter';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import type {
  DpopMode,
  DpopProofInput,
  DpopProofVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token-dpop.port';
import type { VerifiedUserAccessToken } from '@/modules/auth/web-sessions/application/user-access-token.port';

import { UserAccessJwtGuard } from './user-access-jwt.guard';

const ISSUER = 'https://api.test.aihub.example.com';
const TOKEN = 'compact.token.value';

const webToken: VerifiedUserAccessToken = {
  userId: 'usr_01J00000000000000000000000',
  issuer: ISSUER,
  jti: 'jti_01',
  validUntil: new Date(Date.now() + 960_000),
  session: { kind: 'web', id: 'wss_01J00000000000000000000000' },
  jkt: 'bound-thumbprint',
};
const unboundWebToken: VerifiedUserAccessToken = {
  userId: webToken.userId,
  issuer: ISSUER,
  jti: 'jti_02',
  validUntil: webToken.validUntil,
  session: webToken.session!,
};
const refreshToken: VerifiedUserAccessToken = {
  userId: webToken.userId,
  issuer: ISSUER,
  jti: 'jti_03',
  validUntil: webToken.validUntil,
  session: { kind: 'refresh', id: 'rfs_01J00000000000000000000000' },
};

function context(
  request: Record<string, unknown>,
  response: { header: jest.Mock },
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function requestWith(
  headers: Record<string, string | string[]>,
): Record<string, unknown> {
  return {
    method: 'GET',
    protocol: 'https',
    hostname: 'api.test.aihub.example.com',
    url: '/v1/me?limit=5',
    headers,
  };
}

function setup(
  mode: DpopMode,
  token: VerifiedUserAccessToken,
  proofVerifier: DpopProofVerifierPort = { verify: async () => undefined },
) {
  const state = createInMemoryAuthState();
  seedAccount(state, {
    userId: token.userId,
    email: 'person@example.com',
    passwordHash: '$argon2id$fake',
    status: 'active',
  });
  const seen: DpopProofInput[] = [];
  const guard = new UserAccessJwtGuard(
    { verify: async () => token },
    new InMemoryUserAccountAdapter(state),
    new InMemoryUserAccessTokenRevocationAdapter(),
    {
      mode,
      verifier: {
        verify: async (input) => {
          seen.push(input);
          return proofVerifier.verify(input);
        },
      },
    },
  );
  return { guard, seen, response: { header: jest.fn() } };
}

describe('UserAccessJwtGuard DPoP modes', () => {
  it('off: refuses the DPoP scheme and never consults the proof verifier', async () => {
    const { guard, seen, response } = setup('off', webToken);

    await expect(
      guard.canActivate(
        context(
          requestWith({ authorization: `DPoP ${TOKEN}`, dpop: 'proof' }),
          response,
        ),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
    expect(seen).toEqual([]);
  });

  it.each<DpopMode>(['verify', 'enforce'])(
    '%s: accepts a bound token with a valid proof and checks it against the request',
    async (mode) => {
      const { guard, seen, response } = setup(mode, webToken);
      const request = requestWith({
        authorization: `DPoP ${TOKEN}`,
        dpop: 'the-proof',
      });

      await expect(guard.canActivate(context(request, response))).resolves.toBe(
        true,
      );

      expect(seen).toEqual([
        {
          proof: 'the-proof',
          method: 'GET',
          url: 'https://api.test.aihub.example.com/v1/me',
          accessToken: TOKEN,
          expectedJkt: 'bound-thumbprint',
          issuer: ISSUER,
        },
      ]);
      expect(request['aihubUser']).toMatchObject({ userId: webToken.userId });
    },
  );

  it('verify: still accepts Bearer for a web-session token', async () => {
    const { guard, response } = setup('verify', unboundWebToken);

    await expect(
      guard.canActivate(
        context(requestWith({ authorization: `Bearer ${TOKEN}` }), response),
      ),
    ).resolves.toBe(true);
  });

  it('enforce: refuses Bearer for a web-session token and challenges with DPoP', async () => {
    const { guard, response } = setup('enforce', unboundWebToken);

    await expect(
      guard.canActivate(
        context(requestWith({ authorization: `Bearer ${TOKEN}` }), response),
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
      httpStatus: 401,
    });
    expect(response.header).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'DPoP algs="ES256"',
    );
  });

  it('enforce: leaves Bearer working for a token that is not a web-session token', async () => {
    const { guard, response } = setup('enforce', refreshToken);

    await expect(
      guard.canActivate(
        context(requestWith({ authorization: `Bearer ${TOKEN}` }), response),
      ),
    ).resolves.toBe(true);
  });

  it.each([
    [
      'a token that was never bound to a key',
      unboundWebToken,
      { authorization: `DPoP ${TOKEN}`, dpop: 'p' },
    ],
    ['a missing DPoP header', webToken, { authorization: `DPoP ${TOKEN}` }],
    [
      'a duplicated DPoP header',
      webToken,
      { authorization: `DPoP ${TOKEN}`, dpop: ['a', 'b'] },
    ],
  ])(
    'verify: refuses the DPoP scheme with %s',
    async (_label, token, headers) => {
      const { guard, seen, response } = setup('verify', token);

      await expect(
        guard.canActivate(context(requestWith(headers), response)),
      ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
      expect(seen.length).toBeLessThanOrEqual(0);
    },
  );

  it('refuses a proof the verifier rejects', async () => {
    const { guard, response } = setup('enforce', webToken, {
      verify: async () => {
        throw invalidUserAccessToken();
      },
    });

    await expect(
      guard.canActivate(
        context(
          requestWith({ authorization: `DPoP ${TOKEN}`, dpop: 'p' }),
          response,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
      httpStatus: 401,
    });
  });

  it('fails closed with a retryable 503, never a fallback, when replay state is unavailable', async () => {
    const { guard, response } = setup('enforce', webToken, {
      verify: async () => {
        throw new Error('redis down');
      },
    });

    await expect(
      guard.canActivate(
        context(
          requestWith({ authorization: `DPoP ${TOKEN}`, dpop: 'p' }),
          response,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
  });
});

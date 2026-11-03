import { type InMemoryAuthState } from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  NOW,
  backlogged,
  issuedToken,
  issuedVerificationExpiresAt,
  localAuth,
  refusal,
} from '@/modules/auth/testing/local-auth.service.spec-support';

describe('LocalRegistrationService', () => {
  describe('email outbox backpressure', () => {
    it('refuses a registration with a retryable 503 before any rate limit or durable write', async () => {
      const { registration, state, limiter, refusals } = localAuth(backlogged);

      const error = await refusal(
        registration.register(
          { email: EMAIL, username: 'person_01', password: 'exact password' },
          '203.0.113.7',
        ),
      );

      expect(error).toMatchObject({
        code: 'EMAIL_DELIVERY_BACKLOGGED',
        httpStatus: 503,
        retryable: true,
      });
      expect(error.retryAfterMs).toBeGreaterThan(0);
      expect(limiter.calls).toEqual([]);
      expect(state.accounts.size).toBe(0);
      expect(state.verificationTokens.size).toBe(0);
      expect(state.emailDeliveryRequests).toEqual([]);
      expect(refusals).toEqual(['verification_email']);
    });

    it('refuses a verification resend the same way, without spending its limits', async () => {
      const { registration, state, limiter, refusals } = localAuth(backlogged);

      await expect(
        refusal(registration.resend(EMAIL, '203.0.113.7')),
      ).resolves.toMatchObject({ code: 'EMAIL_DELIVERY_BACKLOGGED' });

      expect(limiter.calls).toEqual([]);
      expect(state.emailDeliveryRequests).toEqual([]);
      expect(refusals).toEqual(['verification_email']);
    });

    it('proceeds as before when the queue age cannot be read', async () => {
      const { registration, state, limiter, refusals } = localAuth({
        queueAge: async () => {
          throw new Error('database down');
        },
      });

      await registration.register(
        { email: EMAIL, username: 'person_01', password: 'exact password' },
        '203.0.113.7',
      );

      expect(state.emailDeliveryRequests).toHaveLength(1);
      expect(limiter.calls).toHaveLength(2);
      expect(refusals).toEqual([]);
    });

    it('does not ask about the queue for an invalid request', async () => {
      const { registration, queueAges } = localAuth(backlogged);

      await expect(
        registration.register(
          { email: 'not an email', username: 'person_01', password: 'x' },
          '203.0.113.7',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

      expect(queueAges).toEqual([]);
    });
  });

  it('registers a canonical pending account and queues its verification email', async () => {
    const { registration, state, limiter, tokenIssuer } = localAuth();

    await expect(
      registration.register(
        {
          email: ' Person@Example.com ',
          username: ' Person_01 ',
          password: '  exact password  ',
        },
        '203.0.113.7',
      ),
    ).resolves.toEqual({
      email: 'person@example.com',
      username: 'person_01',
      status: 'pending_verification',
      emailDeliveryStatus: 'queued',
    });
    expect([...state.accounts.values()]).toEqual([
      expect.objectContaining({
        email: 'person@example.com',
        username: 'person_01',
        status: 'pending_verification',
        passwordHash: 'argon2:  exact password  ',
      }),
    ]);
    expect([...state.verificationTokens.keys()]).toEqual([
      tokenIssuer.hash('opaque-token-1'),
    ]);
    // One durable handoff, carrying the opaque token and nothing else.
    expect(state.emailDeliveryRequests).toHaveLength(1);
    const request = state.emailDeliveryRequests[0];
    expect(request).toMatchObject({
      kind: 'verification_email',
      createdAt: NOW,
    });
    expect(request?.payload).toEqual({
      email: 'person@example.com',
      token: 'opaque-token-1',
      expiresAt: issuedVerificationExpiresAt(tokenIssuer),
    });
    expect(limiter.calls).toHaveLength(2);
  });

  it('reports an active account or a username held by another account as the one generic identity conflict', async () => {
    const { registration, state } = localAuth();
    const input = {
      email: 'person@example.com',
      username: 'person_01',
      password: 'correct horse battery',
    };
    await registration.register(input, '203.0.113.7');
    const [account] = [...state.accounts.values()];
    if (account === undefined) throw new Error('no account was registered');
    account.status = 'active';

    await expect(
      registration.register(input, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_UNAVAILABLE',
      httpStatus: 409,
    });
    await expect(
      registration.register(
        { ...input, email: 'other@example.com' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_UNAVAILABLE',
      httpStatus: 409,
    });
    expect(state.accounts.size).toBe(1);
    expect(state.emailDeliveryRequests).toHaveLength(1);
  });

  describe('one address has one form (#394)', () => {
    const input = { username: 'person_01', password: 'correct horse battery' };

    it('treats the Unicode and punycode spellings of one domain as one account', async () => {
      const { registration, state } = localAuth();
      await registration.register(
        { ...input, email: 'user@bücher.de' },
        '203.0.113.7',
      );
      const [account] = [...state.accounts.values()];
      if (account === undefined) throw new Error('no account was registered');
      account.status = 'active';

      await expect(
        registration.register(
          { ...input, username: 'person_02', email: 'USER@xn--bcher-kva.de' },
          '203.0.113.7',
        ),
      ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_UNAVAILABLE' });
      expect(
        [...state.accounts.values()].map((stored) => stored.email),
      ).toEqual(['user@xn--bcher-kva.de']);
    });

    it('refuses a look-alike address on every email route with the same validation error', async () => {
      const { registration, recovery, state, limiter, queueAges } = localAuth();
      const lookAlike = 'user@аpple.com';

      await expect(
        registration.register({ ...input, email: lookAlike }, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(
        registration.resend(lookAlike, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(
        recovery.forgotPassword({ email: lookAlike }, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(limiter.calls).toEqual([]);
      expect(queueAges).toEqual([]);
      expect(state.accounts.size).toBe(0);
    });
  });

  describe('registering again on a pending email', () => {
    const first = {
      email: 'person@example.com',
      username: 'person_01',
      password: 'first password value',
    };
    const second = {
      email: 'person@example.com',
      username: 'person_02',
      password: 'second password value',
    };

    it('replaces the pending credential and username and supersedes the open token', async () => {
      const { registration, state, tokenIssuer } = localAuth();
      await registration.register(first, '203.0.113.7');

      await registration.register(second, '203.0.113.7');

      expect([...state.accounts.values()]).toEqual([
        expect.objectContaining({
          email: 'person@example.com',
          username: 'person_02',
          status: 'pending_verification',
          passwordHash: 'argon2:second password value',
        }),
      ]);
      expect([...state.verificationTokens.entries()]).toEqual([
        [
          tokenIssuer.hash('opaque-token-1'),
          expect.objectContaining({ consumedReason: 'superseded' }),
        ],
        [
          tokenIssuer.hash('opaque-token-2'),
          expect.objectContaining({ consumedReason: undefined }),
        ],
      ]);
      expect(state.emailDeliveryRequests).toHaveLength(2);
    });

    it('answers exactly as it does for an email nobody has registered', async () => {
      const fresh = localAuth();
      const replaced = localAuth();
      await replaced.registration.register(first, '203.0.113.7');

      const answerForNewEmail = await fresh.registration.register(
        second,
        '203.0.113.8',
      );
      const answerForPendingEmail = await replaced.registration.register(
        second,
        '203.0.113.7',
      );

      expect(answerForPendingEmail).toEqual(answerForNewEmail);
    });

    it('leaves the pending account unchanged when the new username is held by another account', async () => {
      const { registration, state } = localAuth();
      await registration.register(first, '203.0.113.7');
      await registration.register(
        { ...first, email: 'other@example.com', username: 'person_02' },
        '203.0.113.7',
      );

      await expect(
        registration.register(second, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_UNAVAILABLE' });

      expect(
        [...state.accounts.values()].find(
          (account) => account.email === 'person@example.com',
        ),
      ).toMatchObject({
        username: 'person_01',
        passwordHash: 'argon2:first password value',
      });
    });
  });

  it('returns a generic resend result for unknown addresses', async () => {
    const { registration, state } = localAuth();

    await expect(
      registration.resend('nobody@example.com', '203.0.113.7'),
    ).resolves.toBe(undefined);
    expect(state.verificationTokens.size).toBe(0);
    expect(state.emailDeliveryRequests).toHaveLength(0);
  });

  it('queues the replacement verification email with the rotation', async () => {
    const { registration, state, tokenIssuer } = localAuth();
    await registration.register(
      {
        email: EMAIL,
        username: 'person_01',
        password: 'correct horse battery',
      },
      '203.0.113.7',
    );

    await expect(
      registration.resend(' Person@Example.com ', '203.0.113.7'),
    ).resolves.toBe(undefined);

    expect(state.emailDeliveryRequests).toHaveLength(2);
    const resend = state.emailDeliveryRequests[1];
    expect(resend?.kind).toBe('verification_email');
    expect(resend?.payload).toEqual({
      email: EMAIL,
      token: 'opaque-token-2',
      expiresAt: issuedVerificationExpiresAt(tokenIssuer, 1),
    });
    // The superseded token and the fresh request commit as one unit.
    expect(
      [...state.verificationTokens.values()].map(
        (token) => token.consumedReason,
      ),
    ).toEqual(['superseded', undefined]);
  });

  it('uses one generic invalid result for an unknown verification token', async () => {
    const { registration } = localAuth();

    await expect(
      registration.verify('bad-token', '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_VERIFICATION_TOKEN_INVALID',
    });
  });

  describe('verification password (ADR-0123)', () => {
    const registration = {
      email: EMAIL,
      username: 'person_01',
      password: 'correct horse battery',
    };

    async function registered(requireVerificationPassword: boolean) {
      const context = localAuth({ requireVerificationPassword });
      // The shared fake accepts any password; these tests need it to compare.
      context.hasher.verify = async (password, encodedHash) =>
        encodedHash === `argon2:${password}`;
      await context.registration.register(registration, '203.0.113.7');
      return { ...context, rawToken: issuedToken(context.tokenIssuer.issued) };
    }

    function accountStatus(context: { state: InMemoryAuthState }) {
      return [...context.state.accounts.values()][0]?.status;
    }

    it('marks the token of a registration made while the setting is on', async () => {
      const { state } = await registered(true);

      expect(
        [...state.verificationTokens.values()].map((t) => t.requiresPassword),
      ).toEqual([true]);
    });

    it('marks no token while the setting is off', async () => {
      const { state } = await registered(false);

      expect(
        [...state.verificationTokens.values()].map((t) => t.requiresPassword),
      ).toEqual([false]);
    });

    it('refuses a token that needs the password when none is sent, and verifies with it', async () => {
      const context = await registered(true);

      await expect(
        context.registration.verify(context.rawToken, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      expect(accountStatus(context)).toBe('pending_verification');

      await expect(
        context.registration.verify(
          context.rawToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).resolves.toBeUndefined();
      expect(accountStatus(context)).toBe('active');
    });

    it('counts wrong passwords and spends the token on the fifth', async () => {
      const context = await registered(true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          context.registration.verify(
            context.rawToken,
            '203.0.113.7',
            undefined,
            'a wrong password',
          ),
        ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      }

      await expect(
        context.registration.verify(
          context.rawToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_TOKEN_INVALID' });
      expect(accountStatus(context)).toBe('pending_verification');
    });

    it('verifies a token that does not need the password with or without one, but refuses a wrong one', async () => {
      const context = await registered(false);

      await expect(
        context.registration.verify(
          context.rawToken,
          '203.0.113.7',
          undefined,
          'a wrong password',
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      await expect(
        context.registration.verify(context.rawToken, '203.0.113.7'),
      ).resolves.toBeUndefined();
      expect(accountStatus(context)).toBe('active');
    });

    it('issues a resent token that needs the password while the setting is on', async () => {
      const context = await registered(true);

      await context.registration.resend(EMAIL, '203.0.113.7');

      expect(
        [...context.state.verificationTokens.values()].map((t) => [
          t.consumedReason,
          t.requiresPassword,
        ]),
      ).toEqual([
        ['superseded', true],
        [undefined, true],
      ]);
    });

    it('needs the password of the latest registration after a pending email registers again', async () => {
      const context = await registered(true);
      const firstToken = context.rawToken;
      await context.registration.register(
        {
          ...registration,
          username: 'person_02',
          password: 'second password!',
        },
        '203.0.113.7',
      );
      const secondToken = issuedToken(context.tokenIssuer.issued, 1);

      await expect(
        context.registration.verify(
          firstToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_TOKEN_INVALID' });
      await expect(
        context.registration.verify(
          secondToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      await expect(
        context.registration.verify(
          secondToken,
          '203.0.113.7',
          undefined,
          'second password!',
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('Verification Sign-in', () => {
    const binding = 'b'.repeat(43);

    async function registerBound(context: ReturnType<typeof localAuth>) {
      await context.registration.register(
        {
          email: EMAIL,
          username: 'person_01',
          password: 'correct horse battery',
        },
        '203.0.113.7',
        binding,
      );
      return issuedToken(context.tokenIssuer.issued);
    }

    it('stores only the hash of the Signup Browser Binding', async () => {
      const context = localAuth();
      await registerBound(context);
      await context.registration.resend(EMAIL, '203.0.113.7', binding);
      const resend = issuedToken(context.tokenIssuer.issued, 1);
      await context.registration.verify(resend, '203.0.113.7', binding);

      const stored = [...context.state.verificationTokens.values()];
      expect(stored).toHaveLength(2);
      for (const persisted of stored) {
        expect(persisted.browserBindingHash).toBe(`hash:${binding}`);
      }
      expect(JSON.stringify(stored)).not.toContain(`"${binding}"`);
    });

    it('returns no session when the browser binding does not match', async () => {
      const context = localAuth();
      const token = await registerBound(context);

      await expect(
        context.registration.verify(token, '203.0.113.7'),
      ).resolves.toBeUndefined();
      expect(context.state.refreshTokens.size).toBe(0);
      expect(
        [...context.state.verificationTokens.values()][0]?.signedInAt,
      ).toBeUndefined();
    });

    it('leaves the bound browser its sign-in after another device verifies', async () => {
      const context = localAuth();
      const token = await registerBound(context);

      await expect(
        context.registration.verify(token, '203.0.113.7'),
      ).resolves.toBeUndefined();
      await expect(
        context.registration.verify(token, '203.0.113.7', binding),
      ).resolves.toEqual({
        accessToken: 'jwt-for-usr_in_memory_1',
        expiresIn: 900,
        refreshToken: 'refresh-2',
      });
    });

    it('issues a login-equivalent session once, committed with the claim', async () => {
      const context = localAuth();
      const token = await registerBound(context);

      await expect(
        context.registration.verify(token, '203.0.113.7', binding),
      ).resolves.toEqual({
        accessToken: 'jwt-for-usr_in_memory_1',
        expiresIn: 900,
        refreshToken: 'refresh-1',
      });
      expect([...context.state.refreshTokens.values()]).toEqual([
        expect.objectContaining({ userId: 'usr_in_memory_1' }),
      ]);

      await expect(
        context.registration.verify(token, '203.0.113.7', binding),
      ).resolves.toBeUndefined();
      expect(context.state.refreshTokens.size).toBe(1);
    });
  });
});

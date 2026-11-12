import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  type LocalAuthTestContext,
  USER_ID,
  createLocalAuthTestContext,
} from '@/modules/auth/testing/local-auth.controller.spec-support';

describe('local auth HTTP boundary - verification sign-in', () => {
  let c: LocalAuthTestContext;
  beforeAll(async () => {
    c = await createLocalAuthTestContext();
  });
  afterAll(async () => {
    await c.app.close();
  });
  beforeEach(() => {
    c.reset();
  });

  function issuedVerificationToken(index = 0): string {
    const token = c.tokenIssuer.issued[index];
    if (token === undefined) {
      throw new Error(`no verification token was issued at position ${index}`);
    }
    return token.raw;
  }

  describe('Verification Sign-in', () => {
    const binding = 'b'.repeat(43);

    async function registerBound(): Promise<string> {
      await c.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: {
          email: EMAIL,
          username: 'person_01',
          password: 'correct horse battery',
          browser_binding: binding,
        },
      });
      return issuedVerificationToken();
    }

    it('stores only the hash of the binding sent with register and resend', async () => {
      const token = await registerBound();
      await c.app.inject({
        method: 'POST',
        url: '/v1/auth/resend-verification',
        headers: { 'content-type': 'application/json' },
        payload: { email: EMAIL, browser_binding: binding },
      });
      await c.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, browser_binding: binding },
      });

      const stored = [...c.state.verificationTokens.values()];
      expect(stored).toHaveLength(2);
      for (const persisted of stored) {
        expect(persisted.browserBindingHash).toBe(`hash:${binding}`);
      }
      expect(JSON.stringify(stored)).not.toContain(`"${binding}"`);
    });

    it('signs in the signup browser once when the binding matches', async () => {
      const token = await registerBound();

      const first = await c.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, browser_binding: binding },
      });

      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      const body = first.json<{
        data: { access_token: string; token_type: string; expires_in: number };
        meta: { request_id: string };
      }>();
      expect(body).toEqual({
        data: {
          access_token: 'ey.fake.access',
          token_type: 'Bearer',
          expires_in: 900,
        },
        meta: { request_id: body.meta.request_id },
      });
      expect(body.meta.request_id).toMatch(/^req_/);
      const setCookie = first.headers['set-cookie'];
      expect(Array.isArray(setCookie) ? setCookie : [setCookie]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^__Host-aihub_refresh=.+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
          ),
        ]),
      );
      expect(first.payload).not.toContain(binding);
      expect(c.state.refreshTokens.size).toBe(1);

      const replay = await c.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, browser_binding: binding },
      });
      expect(replay.statusCode).toBe(204);
      expect(replay.headers['set-cookie']).toBeUndefined();
      expect(c.state.refreshTokens.size).toBe(1);
    });

    it.each([
      ['no binding', {}],
      ['another browser binding', { browser_binding: 'c'.repeat(43) }],
    ])('only verifies with %s', async (_name, extra) => {
      const token = await registerBound();
      const response = await c.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, ...extra },
      });

      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(c.state.refreshTokens.size).toBe(0);
    });

    it.each([
      [
        '/v1/auth/register',
        { email: 'bound@example.com', username: 'bound_01' },
      ],
      ['/v1/auth/resend-verification', { email: 'bound@example.com' }],
    ])('rejects a malformed binding on %s', async (url, body) => {
      const response = await c.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { ...body, browser_binding: 'too-short' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
    });
  });

  void seedAccount;
  void USER_ID;
});

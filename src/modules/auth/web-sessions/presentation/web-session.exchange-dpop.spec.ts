import { createHash } from 'node:crypto';

import { type JWK, exportJWK, generateKeyPair } from 'jose';

import {
  CLIENT_SECRET,
  createWebSessionTestHelpers,
  createWebSessionTestSuite,
} from '@/modules/auth/testing/web-session.spec-support';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';

async function publicKey(
  alg: 'ES256' | 'ES384' = 'ES256',
): Promise<{ jwk: JWK; jkt: string }> {
  const { publicKey: key } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(key);
  // RFC 7638, computed here rather than by jose: SHA-256 over the required
  // members of an EC key in lexicographic order.
  const jkt = createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
  return { jwk, jkt };
}

describe('web session exchange with a Client proof key', () => {
  const suite = createWebSessionTestSuite(registerRequestCompletionLog);
  const helpers = createWebSessionTestHelpers(() => suite.context, URL);

  beforeEach(() => {
    helpers.seedActiveAccount();
  });

  function exchangeWith(token: string, clientProofKey?: unknown) {
    return suite.context.app.inject({
      method: 'POST',
      url: EXCHANGE_URL,
      headers: {
        'content-type': 'application/json',
        'x-aihub-client-secret': CLIENT_SECRET,
      },
      payload: {
        web_session_token: token,
        ...(clientProofKey === undefined
          ? {}
          : { client_proof_key: clientProofKey }),
      },
    });
  }

  async function accessTokenOf(
    response: Awaited<ReturnType<typeof exchangeWith>>,
  ) {
    expect(response.statusCode).toBe(200);
    const token = (response.json() as { data: { access_token: string } }).data
      .access_token;
    return suite.context.verifier.verify(token);
  }

  it('binds the issued access token to the submitted key through its thumbprint', async () => {
    const token = await helpers.webSessionToken();
    const key = await publicKey();

    const response = await exchangeWith(token, key.jwk);
    const body = response.json<{
      data: { token_type: string; dpop_bound: boolean };
    }>();
    expect(body.data).toMatchObject({
      token_type: 'Bearer',
      dpop_bound: true,
    });
    const verified = await accessTokenOf(response);

    expect(verified.jkt).toBe(key.jkt);
    expect(verified.session?.kind).toBe('web');
  });

  it('still issues an unbound access token when no key is submitted', async () => {
    const token = await helpers.webSessionToken();

    const response = await exchangeWith(token);
    const body = response.json<{ data: { token_type: string } }>();
    expect(body.data.token_type).toBe('Bearer');
    const verified = await accessTokenOf(response);

    expect(verified.jkt).toBeUndefined();
  });

  it('keeps one proof key per Web Session and requires sign-in to replace it', async () => {
    const token = await helpers.webSessionToken();
    const boundKey = await publicKey();
    const replacementKey = await publicKey();

    expect((await exchangeWith(token, boundKey.jwk)).statusCode).toBe(200);
    expect((await exchangeWith(token, boundKey.jwk)).statusCode).toBe(200);

    const replacement = await exchangeWith(token, replacementKey.jwk);
    expect(replacement.statusCode).toBe(401);
    expect(replacement.json()).toMatchObject({
      error: { code: 'AUTH_WEB_SESSION_INVALID' },
    });

    const omitted = await exchangeWith(token);
    expect(omitted.statusCode).toBe(401);
    expect(omitted.json()).toMatchObject({
      error: { code: 'AUTH_WEB_SESSION_INVALID' },
    });
  });

  it('refuses coordinates that do not identify a P-256 point', async () => {
    const token = await helpers.webSessionToken();

    const response = await exchangeWith(token, {
      kty: 'EC',
      crv: 'P-256',
      x: 'A'.repeat(43),
      y: 'A'.repeat(43),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('refuses a key that carries private material, and echoes none of it', async () => {
    const token = await helpers.webSessionToken();
    const { jwk } = await publicKey();

    const response = await exchangeWith(token, { ...jwk, d: 'private-part' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(response.payload).not.toContain('private-part');
  });

  it.each([
    ['another curve', async () => (await publicKey('ES384')).jwk],
    ['a key without coordinates', async () => ({ kty: 'EC', crv: 'P-256' })],
    [
      'an unknown member',
      async () => ({ ...(await publicKey()).jwk, x5c: [] }),
    ],
    ['a non-object value', async () => 'not-a-key'],
  ])('refuses %s', async (_label, makeKey) => {
    const token = await helpers.webSessionToken();

    const response = await exchangeWith(token, await makeKey());

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });
});

import { createHash } from 'node:crypto';

import {
  type CryptoKey,
  type JWK,
  type KeyObject,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose';

import type {
  DpopProofInput,
  DpopReplayCachePort,
  DpopReplayKey,
} from '@/modules/auth/web-sessions/application/user-access-token-dpop.port';

import { JoseDpopProofVerifier } from './jose-dpop-proof.verifier';

const NOW = 1_800_000_000;
const ISSUER = 'https://api.test.aihub.example.com';
const REQUEST_URL = 'https://api.test.aihub.example.com/v1/me';
const ACCESS_TOKEN = 'aaa.bbb.ccc';

class InMemoryReplayCache implements DpopReplayCachePort {
  readonly claimed: { key: DpopReplayKey; ttlSeconds: number }[] = [];

  async claim(key: DpopReplayKey, ttlSeconds: number): Promise<boolean> {
    const id = (k: DpopReplayKey): string => `${k.issuer}|${k.jkt}|${k.jti}`;
    if (this.claimed.some((entry) => id(entry.key) === id(key))) return false;
    this.claimed.push({ key, ttlSeconds });
    return true;
  }
}

interface ClientKey {
  readonly privateKey: CryptoKey | KeyObject;
  readonly jwk: JWK;
  readonly jkt: string;
}

async function clientKey(): Promise<ClientKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk) };
}

function accessTokenHash(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('base64url');
}

async function proofFor(
  key: ClientKey,
  overrides: {
    readonly htm?: string;
    readonly htu?: string;
    readonly ath?: string;
    readonly jti?: string;
    readonly iat?: number;
    readonly typ?: string;
  } = {},
): Promise<string> {
  return new SignJWT({
    htm: overrides.htm ?? 'GET',
    htu: overrides.htu ?? REQUEST_URL,
    ath: overrides.ath ?? accessTokenHash(ACCESS_TOKEN),
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: overrides.typ ?? 'dpop+jwt',
      jwk: key.jwk,
    })
    .setJti(overrides.jti ?? 'proof-1')
    .setIssuedAt(overrides.iat ?? NOW)
    .sign(key.privateKey);
}

function inputFor(
  key: ClientKey,
  proof: string,
  overrides: Partial<DpopProofInput> = {},
): DpopProofInput {
  return {
    proof,
    method: 'GET',
    url: REQUEST_URL,
    accessToken: ACCESS_TOKEN,
    expectedJkt: key.jkt,
    issuer: ISSUER,
    ...overrides,
  };
}

function subject(cache: DpopReplayCachePort = new InMemoryReplayCache()) {
  return new JoseDpopProofVerifier(cache, { clockSkewSeconds: 60 }, () => NOW);
}

const INVALID = { code: 'AUTH_USER_ACCESS_TOKEN_INVALID' };

describe('JoseDpopProofVerifier', () => {
  it('accepts a proof bound to the request, the token and the key, and claims its jti for 180 seconds', async () => {
    const cache = new InMemoryReplayCache();
    const key = await clientKey();

    await expect(
      subject(cache).verify(inputFor(key, await proofFor(key))),
    ).resolves.toBeUndefined();

    expect(cache.claimed).toEqual([
      {
        key: { issuer: ISSUER, jkt: key.jkt, jti: 'proof-1' },
        ttlSeconds: 180,
      },
    ]);
  });

  it('accepts an uppercase DPoP media type in the protected header', async () => {
    const key = await clientKey();

    await expect(
      subject().verify(inputFor(key, await proofFor(key, { typ: 'DPOP+JWT' }))),
    ).resolves.toBeUndefined();
  });

  it('accepts a request URL that carries a query when the proof names the URL without it', async () => {
    const key = await clientKey();

    await expect(
      subject().verify(
        inputFor(key, await proofFor(key), {
          url: `${REQUEST_URL}?limit=5#top`,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a proof whose htu carries a query string', async () => {
    const key = await clientKey();
    const proof = await proofFor(key, { htu: `${REQUEST_URL}?limit=5` });

    await expect(
      subject().verify(inputFor(key, proof, { url: `${REQUEST_URL}?limit=5` })),
    ).rejects.toMatchObject(INVALID);
  });

  it('accepts a fractional iat NumericDate within the proof window', async () => {
    const key = await clientKey();

    await expect(
      subject().verify(inputFor(key, await proofFor(key, { iat: NOW - 0.5 }))),
    ).resolves.toBeUndefined();
  });

  it('rejects a proof made for a different access token', async () => {
    const key = await clientKey();
    const proof = await proofFor(key, { ath: accessTokenHash('x.y.z') });

    await expect(subject().verify(inputFor(key, proof))).rejects.toMatchObject(
      INVALID,
    );
  });

  it('rejects the same proof presented twice', async () => {
    const cache = new InMemoryReplayCache();
    const key = await clientKey();
    const proof = await proofFor(key);
    const verifier = subject(cache);

    await verifier.verify(inputFor(key, proof));

    await expect(verifier.verify(inputFor(key, proof))).rejects.toMatchObject(
      INVALID,
    );
  });

  it('rejects a proof signed by a key other than the one the token is bound to', async () => {
    const bound = await clientKey();
    const other = await clientKey();

    await expect(
      subject().verify(
        inputFor(other, await proofFor(other), { expectedJkt: bound.jkt }),
      ),
    ).rejects.toMatchObject(INVALID);
  });

  it('rejects a proof for another method or one issued outside the clock skew', async () => {
    const key = await clientKey();

    await expect(
      subject().verify(
        inputFor(key, await proofFor(key, { jti: 'm' }), { method: 'POST' }),
      ),
    ).rejects.toMatchObject(INVALID);
    await expect(
      subject().verify(
        inputFor(key, await proofFor(key, { jti: 'old', iat: NOW - 61 })),
      ),
    ).rejects.toMatchObject(INVALID);
  });

  it('fails closed with the cache error itself when the replay cache is unavailable', async () => {
    const unavailable = new Error('redis down');
    const cache: DpopReplayCachePort = {
      claim: () => Promise.reject(unavailable),
    };
    const key = await clientKey();

    await expect(
      subject(cache).verify(inputFor(key, await proofFor(key))),
    ).rejects.toBe(unavailable);
  });
});

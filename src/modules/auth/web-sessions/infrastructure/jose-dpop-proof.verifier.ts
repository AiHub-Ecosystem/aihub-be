import { createHash } from 'node:crypto';

import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from 'jose';

import { invalidUserAccessToken } from '@/modules/auth/shared/application/local-auth-errors';
import { isDpopPublicJwk } from '@/modules/auth/web-sessions/application/dpop-proof-key';
import type {
  DpopProofInput,
  DpopProofVerifierPort,
  DpopReplayCachePort,
} from '@/modules/auth/web-sessions/application/user-access-token-dpop.port';

export interface DpopProofVerifierConfig {
  readonly clockSkewSeconds: number;
}

const PROOF_TYP = 'dpop+jwt';
const PROOF_ALG = 'ES256';
const MAX_JTI_LENGTH = 256;
/** The proof is accepted for skew on either side of `iat`, plus one minute of margin. */
const REPLAY_MARGIN_SECONDS = 60;

function withoutQueryAndFragment(url: URL): string {
  const copy = new URL(url.href);
  copy.search = '';
  copy.hash = '';
  return copy.href;
}

export class JoseDpopProofVerifier implements DpopProofVerifierPort {
  constructor(
    private readonly replayCache: DpopReplayCachePort,
    private readonly config: DpopProofVerifierConfig,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async verify(input: DpopProofInput): Promise<void> {
    const jti = await this.verifyProof(input);

    // A cache failure is not a verdict on the proof: it propagates unchanged so
    // the caller can fail closed instead of trusting an unchecked proof.
    const claimed = await this.replayCache.claim(
      { issuer: input.issuer, jkt: input.expectedJkt, jti },
      this.config.clockSkewSeconds * 2 + REPLAY_MARGIN_SECONDS,
    );
    if (!claimed) throw invalidUserAccessToken();
  }

  private async verifyProof(input: DpopProofInput): Promise<string> {
    try {
      const header = decodeProtectedHeader(input.proof);
      const jwk = header.jwk;
      if (
        header.typ !== PROOF_TYP ||
        header.alg !== PROOF_ALG ||
        !isDpopPublicJwk(jwk)
      ) {
        throw invalidUserAccessToken();
      }

      const { payload } = await jwtVerify(
        input.proof,
        await importJWK(jwk, PROOF_ALG),
        {
          algorithms: [PROOF_ALG],
          typ: PROOF_TYP,
          clockTolerance: this.config.clockSkewSeconds,
        },
      );

      if ((await calculateJwkThumbprint(jwk)) !== input.expectedJkt) {
        throw invalidUserAccessToken();
      }

      const htm = payload['htm'];
      const htu = payload['htu'];
      const ath = payload['ath'];
      const { jti, iat } = payload;
      if (
        htm !== input.method ||
        typeof htu !== 'string' ||
        typeof ath !== 'string' ||
        typeof jti !== 'string' ||
        jti.length === 0 ||
        jti.length > MAX_JTI_LENGTH ||
        typeof iat !== 'number' ||
        !Number.isFinite(iat) ||
        Math.abs(this.now() - iat) > this.config.clockSkewSeconds
      ) {
        throw invalidUserAccessToken();
      }

      const proofUrl = new URL(htu);
      if (
        proofUrl.search !== '' ||
        proofUrl.hash !== '' ||
        proofUrl.href !== withoutQueryAndFragment(new URL(input.url))
      ) {
        throw invalidUserAccessToken();
      }

      const expectedAth = createHash('sha256')
        .update(input.accessToken, 'ascii')
        .digest('base64url');
      if (ath !== expectedAth) throw invalidUserAccessToken();

      return jti;
    } catch {
      throw invalidUserAccessToken();
    }
  }
}

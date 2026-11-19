export interface DpopProofInput {
  /** The compact DPoP proof JWT from the `DPoP` request header. */
  readonly proof: string;
  /** HTTP method of the request, exactly as received. */
  readonly method: string;
  /** Absolute request URL as the trusted proxy normalized it; query and fragment are ignored. */
  readonly url: string;
  /** The compact User Access JWT the proof must be bound to (`ath`). */
  readonly accessToken: string;
  /** Proof key thumbprint (`cnf.jkt`) of the verified User Access JWT. */
  readonly expectedJkt: string;
  readonly issuer: string;
}

/**
 * Resolves with no value when the proof is valid for this request and token.
 * Any invalid proof rejects with the invalid User Access JWT error. A replay
 * cache failure rejects unchanged so the caller can fail closed.
 */
export interface DpopProofVerifierPort {
  verify(input: DpopProofInput): Promise<void>;
}

export interface DpopReplayKey {
  readonly issuer: string;
  readonly jkt: string;
  readonly jti: string;
}

/** Ephemeral anti-replay state; never a source of truth. */
export interface DpopReplayCachePort {
  /** True when this proof identifier was not seen before and is now claimed. */
  claim(key: DpopReplayKey, ttlSeconds: number): Promise<boolean>;
}

/**
 * `off` accepts only Bearer; `verify` also accepts DPoP-bound tokens and keeps
 * Bearer working; `enforce` requires DPoP for web-session tokens.
 */
export type DpopMode = 'off' | 'verify' | 'enforce';

export interface DpopGuardPolicy {
  readonly mode: DpopMode;
  readonly verifier: DpopProofVerifierPort;
}

export const USER_ACCESS_DPOP_POLICY = Symbol('USER_ACCESS_DPOP_POLICY');
export const DPOP_REPLAY_CACHE = Symbol('DPOP_REPLAY_CACHE');

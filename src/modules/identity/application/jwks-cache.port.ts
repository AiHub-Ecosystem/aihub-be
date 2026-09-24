import type { PublicJsonWebKeySet } from './organization-identity-config-repository.port';

export interface JwksCacheEntry {
  readonly jwks: PublicJsonWebKeySet;
  readonly freshUntil: number;
  readonly staleUntil: number;
}

export interface JwksRefreshLock {
  readonly acquired: boolean;
  readonly available: boolean;
}

export interface JwksCachePort {
  getJwks(
    organizationId: string,
    version: string,
  ): Promise<JwksCacheEntry | undefined>;
  setJwks(
    organizationId: string,
    version: string,
    entry: JwksCacheEntry,
  ): Promise<void>;
  deleteJwks(organizationId: string, currentVersion: string): Promise<void>;
  tryAcquireRefresh(organizationId: string): Promise<JwksRefreshLock>;
}

export const JWKS_CACHE = Symbol('JWKS_CACHE');

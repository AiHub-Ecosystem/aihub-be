import type { PublicJsonWebKeySet } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';

export interface JwksCacheEntry {
  readonly jwks: PublicJsonWebKeySet;
  readonly freshUntil: number;
  readonly staleUntil: number;
}

export interface JwksRefreshLock {
  readonly acquired: boolean;
  readonly available: boolean;
}

export interface JwksCacheSnapshot {
  readonly generation: string;
  readonly entry?: JwksCacheEntry;
}

export interface JwksCachePort {
  getJwks(
    organizationId: string,
    configVersion: string,
  ): Promise<JwksCacheSnapshot>;
  setJwks(
    organizationId: string,
    configVersion: string,
    generation: string,
    entry: JwksCacheEntry,
  ): Promise<void>;
  deleteJwks(organizationId: string, configVersion: string): Promise<void>;
  tryAcquireRefresh(organizationId: string): Promise<JwksRefreshLock>;
}

export const JWKS_CACHE = Symbol('JWKS_CACHE');

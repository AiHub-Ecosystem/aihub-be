import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { PublicJsonWebKey } from '@/modules/identity/domain/organization-identity-config';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import type {
  OrganizationIdentityConfigRepositoryPort,
  SaveOrganizationIdentityConfigInput,
  StoredOrganizationIdentityConfig,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { SetOrganizationIdentityConfig } from '@/modules/identity/organization-identity-configuration/application/set-organization-identity-config';
import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksCacheSnapshot,
  JwksRefreshLock,
} from '@/modules/identity/user-assertions/application/jwks-cache.port';
import type { UserAssertionCryptoPort } from '@/modules/identity/user-assertions/application/user-assertion-crypto.port';
import { UserAssertionVerifier } from '@/modules/identity/user-assertions/application/user-assertion-verifier';
import { UserIdentityResolver } from '@/modules/identity/user-assertions/application/user-identity-resolver';
import { JwksKeyProvider } from '@/modules/identity/user-assertions/infrastructure/jwks-key-provider';

const ORGANIZATION_ID = 'org_acme';
const ISSUER = 'https://acme.edu';
const JWKS_URL = 'https://id.acme.edu/keys';
const oldJwks = {
  keys: [{ kty: 'RSA', n: 'old-modulus', e: 'AQAB', kid: 'old-key' }],
};
const newJwks = {
  keys: [{ kty: 'RSA', n: 'new-modulus', e: 'AQAB', kid: 'new-key' }],
};

class Cache implements JwksCachePort {
  entry: JwksCacheEntry | undefined = {
    jwks: oldJwks,
    freshUntil: Date.now() + 60_000,
    staleUntil: Date.now() + 120_000,
  };

  readonly versions = new Map<string, JwksCacheEntry>();
  generation = '0';

  async getJwks(
    _organizationId: string,
    configVersion: string,
  ): Promise<JwksCacheSnapshot> {
    const entry =
      this.versions.get(`${configVersion}:${this.generation}`) ??
      (this.generation === '0' && configVersion === '1'
        ? this.entry
        : undefined);
    return entry === undefined
      ? { generation: this.generation }
      : { generation: this.generation, entry };
  }

  async setJwks(
    _organizationId: string,
    configVersion: string,
    generation: string,
    entry: JwksCacheEntry,
  ): Promise<void> {
    this.versions.set(`${configVersion}:${generation}`, entry);
    this.entry = entry;
  }

  async deleteJwks(
    _organizationId: string,
    configVersion: string,
  ): Promise<void> {
    this.versions.delete(`${configVersion}:${this.generation}`);
    this.generation = (BigInt(this.generation) + 1n).toString();
    this.entry = undefined;
  }

  async tryAcquireRefresh(): Promise<JwksRefreshLock> {
    return { acquired: true, available: true };
  }
}

describe('identity configuration save and next assertion verification', () => {
  it('verifies with the newly fetched JWKS after saving and purging the old cache entry', async () => {
    const cache = new Cache();
    let config: StoredOrganizationIdentityConfig = {
      organizationId: ORGANIZATION_ID,
      jwksCacheVersion: '1',
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      publicKeysJwks: null,
      allowedAlgorithms: ['RS256'],
      maxAssertionTtlSeconds: 300,
      status: 'active',
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    };
    const repository: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'saveForOwner' | 'findActiveByOrganizationId'
    > = {
      findActiveByOrganizationId: async (_organizationId: string) => config,
      saveForOwner: async (input: SaveOrganizationIdentityConfigInput) => {
        config = {
          organizationId: input.organizationId,
          jwksCacheVersion: '2',
          issuer: input.issuer,
          jwksUrl: input.jwksUrl,
          publicKeysJwks: input.publicKeysJwks,
          allowedAlgorithms: input.allowedAlgorithms,
          maxAssertionTtlSeconds: input.maxAssertionTtlSeconds,
          status: config.status,
          updatedAt: new Date('2026-09-24T00:00:00.000Z'),
        };
        return { kind: 'saved', config };
      },
    };
    const membership: Pick<OrganizationMembershipPort, 'resolveMembership'> = {
      resolveMembership: async ({ organizationId, userId }) => ({
        kind: 'active',
        membership: {
          organizationId,
          userId,
          organizationStatus: 'active',
          role: 'owner',
          status: 'active',
        },
      }),
    };
    let remoteFetches = 0;
    const keys = new JwksKeyProvider(
      cache,
      async () => {
        remoteFetches += 1;
        return new Response(JSON.stringify(newJwks));
      },
      () => ({
        resolve4: async () => ['8.8.8.8'],
        resolve6: async () => [],
        cancel: jest.fn(),
      }),
    );
    const setter = new SetOrganizationIdentityConfig(
      membership,
      repository,
      keys,
      cache,
    );
    const context = createRequestContext({
      requestId: 'req_01J00000000000000000000000',
      receivedAt: new Date('2026-09-24T00:00:00.000Z'),
      deadlineMs: 5_000,
      userId: 'usr_01J00000000000000000000000',
      scopes: [],
    });

    await setter.set({
      context,
      userId: 'usr_01J00000000000000000000000',
      organizationId: ORGANIZATION_ID,
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      publicKeysJwks: null,
      allowedAlgorithms: ['RS256'],
    });

    let verifiedKey: PublicJsonWebKey | undefined;
    const crypto: UserAssertionCryptoPort = {
      decodeHeader: () => ({ alg: 'RS256', kid: 'new-key' }),
      verify: async ({ key }) => {
        verifiedKey = key;
        return {
          iss: ISSUER,
          aud: 'aihub',
          sub: 'user-1',
          jti: 'assertion-1',
          iat: 1_800_000_000,
          exp: 1_800_000_060,
        };
      },
    };
    const verifier = new UserIdentityResolver(
      repository,
      new UserAssertionVerifier(keys, crypto, () => 1_800_000_000),
    );

    await expect(
      verifier.resolve({
        organizationId: ORGANIZATION_ID,
        value: 'signed.assertion',
      }),
    ).resolves.toMatchObject({ userId: 'user-1' });

    expect(verifiedKey).toMatchObject({ kid: 'new-key', n: 'new-modulus' });
    expect(remoteFetches).toBe(2);
    expect(cache.entry?.jwks).toEqual(newJwks);
  });
});

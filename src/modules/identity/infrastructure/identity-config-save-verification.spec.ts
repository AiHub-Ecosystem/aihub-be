import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksRefreshLock,
} from '../application/jwks-cache.port';
import type {
  OrganizationIdentityConfigRepositoryPort,
  SaveOrganizationIdentityConfigInput,
  StoredOrganizationIdentityConfig,
} from '../application/organization-identity-config-repository.port';
import type { OrganizationMembershipPort } from '../application/organization-membership.port';
import { SetOrganizationIdentityConfig } from '../application/set-organization-identity-config';
import type { UserAssertionCryptoPort } from '../application/user-assertion-crypto.port';
import { UserAssertionVerifier } from '../application/user-assertion-verifier';
import type { PublicJsonWebKey } from '../domain/organization-identity-config';
import { JwksKeyProvider } from './jwks-key-provider';

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

  async getJwks(
    _organizationId: string,
    version: string,
  ): Promise<JwksCacheEntry | undefined> {
    return (
      this.versions.get(version) ?? (version === '1' ? this.entry : undefined)
    );
  }

  async setJwks(
    _organizationId: string,
    _version: string,
    entry: JwksCacheEntry,
  ): Promise<void> {
    this.versions.set(_version, entry);
    this.entry = entry;
  }

  async deleteJwks(
    _organizationId: string,
    currentVersion: string,
  ): Promise<void> {
    const version = BigInt(currentVersion);
    this.versions.delete(currentVersion);
    if (version > 1n) {
      this.versions.delete((version - 1n).toString());
    }
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
      async () => [{ address: '8.8.8.8', family: 4 }],
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
    const verifier = new UserAssertionVerifier(
      repository,
      keys,
      crypto,
      () => 1_800_000_000,
    );

    await expect(
      verifier.verify({
        organizationId: ORGANIZATION_ID,
        signedAssertion: 'signed.assertion',
      }),
    ).resolves.toMatchObject({ userId: 'user-1' });

    expect(verifiedKey).toMatchObject({ kid: 'new-key', n: 'new-modulus' });
    expect(remoteFetches).toBe(2);
    expect(cache.entry?.jwks).toEqual(newJwks);
  });
});

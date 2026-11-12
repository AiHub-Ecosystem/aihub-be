import { AppError } from '@/common/errors/app-error';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import type {
  IdentityConfigPrecondition,
  OrganizationIdentityConfigRepositoryPort,
  SaveOrganizationIdentityConfigInput,
  SaveOrganizationIdentityConfigResult,
  StoredOrganizationIdentityConfig,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type { JwksCachePort } from '@/modules/identity/user-assertions/application/jwks-cache.port';
import type { JwksKeyProviderPort } from '@/modules/identity/user-assertions/application/jwks-key-provider.port';
import { jsonWebKeyThumbprint } from './jwk-thumbprint';
import { SetOrganizationIdentityConfig } from './set-organization-identity-config';

const ORGANIZATION_ID = 'org_acme';
const USER_ID = 'usr_01J00000000000000000000000';

const saved: StoredOrganizationIdentityConfig = {
  organizationId: ORGANIZATION_ID,
  jwksCacheVersion: '4',
  issuer: 'https://acme.edu',
  jwksUrl: null,
  publicKeysJwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] },
  allowedAlgorithms: ['RS256'],
  maxAssertionTtlSeconds: 300,
  status: 'active',
  updatedAt: new Date('2026-10-30T00:00:00.000Z'),
  revision: '9',
};

function subject(result: SaveOrganizationIdentityConfigResult) {
  const saves: SaveOrganizationIdentityConfigInput[] = [];
  const deleted: string[] = [];
  const configs: Pick<
    OrganizationIdentityConfigRepositoryPort,
    'saveForOwner'
  > = {
    saveForOwner: async (input) => {
      saves.push(input);
      return result;
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
  const keys: Pick<JwksKeyProviderPort, 'validateRemote'> = {
    validateRemote: async () => ({ keys: [] }),
  };
  const cache: Pick<JwksCachePort, 'deleteJwks'> = {
    deleteJwks: async (_organizationId, version) => {
      deleted.push(version);
    },
  };
  return {
    setter: new SetOrganizationIdentityConfig(membership, configs, keys, cache),
    saves,
    deleted,
  };
}

function setInput(precondition?: IdentityConfigPrecondition) {
  return {
    context: createRequestContext({
      requestId: 'req_01J00000000000000000000000',
      receivedAt: new Date('2026-10-30T00:00:00.000Z'),
      deadlineMs: 5_000,
      userId: USER_ID,
      scopes: [],
    }),
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    issuer: 'https://acme.edu',
    publicKeysJwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] },
    ...(precondition === undefined ? {} : { precondition }),
  };
}

describe('SetOrganizationIdentityConfig precondition (ADR-0132)', () => {
  it('hands the repository the revision the caller read', async () => {
    const { setter, saves } = subject({ kind: 'saved', config: saved });

    await setter.set(setInput({ kind: 'revision', revision: '8' }));

    expect(saves[0]?.precondition).toEqual({ kind: 'revision', revision: '8' });
  });

  it('hands the repository a create-only request', async () => {
    const { setter, saves } = subject({ kind: 'saved', config: saved });

    await setter.set(setInput({ kind: 'absent' }));

    expect(saves[0]?.precondition).toEqual({ kind: 'absent' });
  });

  it('keeps an unconditional write unconditional', async () => {
    const { setter, saves } = subject({ kind: 'saved', config: saved });

    await setter.set(setInput());

    expect(saves[0]).not.toHaveProperty('precondition');
  });

  it('answers PRECONDITION_FAILED and leaves the JWKS cache alone when the revision is stale', async () => {
    const { setter, deleted } = subject({ kind: 'precondition_failed' });

    let thrown: unknown;
    try {
      await setter.set(setInput({ kind: 'revision', revision: '8' }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      code: 'PRECONDITION_FAILED',
      httpStatus: 412,
      retryable: false,
    });
    expect(deleted).toEqual([]);
  });

  it('returns the stored configuration with its revision on success', async () => {
    const { setter } = subject({ kind: 'saved', config: saved });

    const config = await setter.set(
      setInput({ kind: 'revision', revision: '8' }),
    );

    expect(config.revision).toBe('9');
  });
});

describe('SetOrganizationIdentityConfig trusted-key thumbprints (#447)', () => {
  it('thumbprints the inline keys the configuration trusts', async () => {
    const { setter, saves } = subject({ kind: 'saved', config: saved });

    await setter.set(setInput());

    expect(saves[0]?.keyThumbprints).toEqual([
      jsonWebKeyThumbprint({ kty: 'RSA', n: 'modulus', e: 'AQAB' }),
    ]);
  });

  it('thumbprints the keys the fetched URL source validated', async () => {
    const remoteKeys = {
      keys: [
        {
          kty: 'EC',
          crv: 'P-256',
          x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
          y: '4Etl6SRW2YiLUrN5vfvCDHh+R8Xht8bUvbBpA7utIGY',
        },
      ],
    };
    const saves: SaveOrganizationIdentityConfigInput[] = [];
    const configs: Pick<
      OrganizationIdentityConfigRepositoryPort,
      'saveForOwner'
    > = {
      saveForOwner: async (input) => {
        saves.push(input);
        return { kind: 'saved', config: saved };
      },
    };
    const setter = new SetOrganizationIdentityConfig(
      {
        resolveMembership: async () => ({
          kind: 'active',
          membership: {
            organizationId: ORGANIZATION_ID,
            userId: USER_ID,
            organizationStatus: 'active',
            role: 'owner',
            status: 'active',
          },
        }),
      },
      configs,
      { validateRemote: async () => remoteKeys },
      { deleteJwks: async () => undefined },
    );

    await setter.set({
      ...setInput(),
      publicKeysJwks: undefined,
      jwksUrl: 'https://acme.edu/jwks.json',
    });

    expect(saves[0]?.keyThumbprints).toEqual([
      jsonWebKeyThumbprint(remoteKeys.keys[0] as never),
    ]);
  });

  it('refuses a key it cannot thumbprint rather than trusting it unrecorded', async () => {
    const setter = new SetOrganizationIdentityConfig(
      {
        resolveMembership: async () => ({
          kind: 'active',
          membership: {
            organizationId: ORGANIZATION_ID,
            userId: USER_ID,
            organizationStatus: 'active',
            role: 'owner',
            status: 'active',
          },
        }),
      },
      {
        saveForOwner: async () => {
          throw new Error('must not save');
        },
      },
      { validateRemote: async () => ({ keys: [{ kty: 'oct', k: 'secret' }] }) },
      { deleteJwks: async () => undefined },
    );

    await expect(
      setter.set({
        ...setInput(),
        publicKeysJwks: undefined,
        jwksUrl: 'https://acme.edu/jwks.json',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_JWKS_INVALID' });
  });
});

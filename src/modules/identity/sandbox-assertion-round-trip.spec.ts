import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';

import { AppError } from '../../common/errors/app-error';
import type { JwksKeyProviderPort } from './application/jwks-key-provider.port';
import { MintSandboxAssertion } from './application/mint-sandbox-assertion';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
  PublicJsonWebKeySet,
} from './application/organization-identity-config-repository.port';
import { UserAssertionVerifier } from './application/user-assertion-verifier';
import { JoseSandboxAssertionSigner } from './infrastructure/jose-sandbox-assertion-signer';
import { JoseUserAssertionCrypto } from './infrastructure/jose-user-assertion-crypto';

const SANDBOX_ORG = 'org_sandbox';
const OTHER_ORG = 'org_acme';
const SANDBOX_ISSUER = 'https://sandbox.aihub.example.com';
const OTHER_ISSUER = 'https://acme.edu';
const KEY_ID = 'sandbox-2026-09';

interface Organization {
  readonly config: OrganizationIdentityConfig;
  readonly jwks: PublicJsonWebKeySet;
}

async function organization(
  organizationId: string,
  issuer: string,
  keyId: string,
): Promise<Organization & { readonly privateKeyPem: string }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const jwks: PublicJsonWebKeySet = {
    keys: [{ ...jwk, kid: keyId, alg: 'RS256', use: 'sig' }],
  };

  return {
    jwks,
    privateKeyPem: await exportPKCS8(privateKey),
    config: {
      organizationId,
      issuer,
      jwksUrl: null,
      publicKeysJwks: jwks,
      allowedAlgorithms: ['RS256'],
      maxAssertionTtlSeconds: 3_600,
      status: 'active',
    },
  };
}

function repository(
  organizations: ReadonlyMap<string, Organization>,
): OrganizationIdentityConfigRepositoryPort {
  return {
    findActiveByOrganizationId: async (organizationId) =>
      organizations.get(organizationId)?.config ?? null,
  };
}

function keyProvider(
  organizations: ReadonlyMap<string, Organization>,
): JwksKeyProviderPort {
  return {
    resolve: async ({ organizationId }) => {
      const found = organizations.get(organizationId);
      if (found === undefined) {
        throw new Error(`no JWKS for ${organizationId}`);
      }

      return found.jwks;
    },
  };
}

/**
 * The property this endpoint rests on is that a minted assertion is accepted
 * by the sandbox organization and by nothing else. Asserting over the claims
 * of a freshly signed token would not show that: it is the verifier's
 * organization-scoped issuer check that provides the containment, so these
 * tests run the real verifier against the real signer.
 */
describe('sandbox assertion round trip', () => {
  let organizations: Map<string, Organization>;
  let minter: MintSandboxAssertion;
  let verifier: UserAssertionVerifier;

  beforeAll(async () => {
    const sandbox = await organization(SANDBOX_ORG, SANDBOX_ISSUER, KEY_ID);
    const other = await organization(OTHER_ORG, OTHER_ISSUER, 'acme-2026-01');

    organizations = new Map([
      [SANDBOX_ORG, sandbox],
      [OTHER_ORG, other],
    ]);

    minter = new MintSandboxAssertion(
      repository(organizations),
      new JoseSandboxAssertionSigner({
        organizationIds: [SANDBOX_ORG],
        privateKeyPem: sandbox.privateKeyPem,
        keyId: KEY_ID,
        algorithm: 'RS256',
      }),
    );

    verifier = new UserAssertionVerifier(
      repository(organizations),
      keyProvider(organizations),
      new JoseUserAssertionCrypto(),
    );
  });

  it('mints an assertion the sandbox organization accepts', async () => {
    const minted = await minter.mint({
      organizationId: SANDBOX_ORG,
      userId: 'student_456',
    });

    await expect(
      verifier.verify({
        signedAssertion: minted.assertion,
        organizationId: SANDBOX_ORG,
      }),
    ).resolves.toEqual({
      userId: 'student_456',
      organizationId: SANDBOX_ORG,
      scopes: [],
    });
  });

  it('rejects that same assertion under another organization', async () => {
    const minted = await minter.mint({
      organizationId: SANDBOX_ORG,
      userId: 'student_456',
    });

    await expect(
      verifier.verify({
        signedAssertion: minted.assertion,
        organizationId: OTHER_ORG,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_ASSERTION' });
  });

  it('honours the organization assertion lifetime', async () => {
    const minted = await minter.mint({
      organizationId: SANDBOX_ORG,
      userId: 'student_456',
    });
    const nowSeconds = Math.floor(Date.now() / 1_000);

    expect(minted.expiresAt).toBeGreaterThan(nowSeconds);
    expect(minted.expiresAt).toBeLessThanOrEqual(nowSeconds + 3_600);
  });

  it('refuses to mint for an organization with no identity configuration', async () => {
    await expect(
      minter.mint({ organizationId: 'org_unknown', userId: 'student_456' }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

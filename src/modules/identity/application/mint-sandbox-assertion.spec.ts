import { createRequestContext } from '../../../common/request-context/request-context.factory';
import { MintSandboxAssertion } from './mint-sandbox-assertion';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
} from './organization-identity-config-repository.port';
import type {
  SandboxAssertionClaims,
  SandboxAssertionSignerPort,
} from './sandbox-assertion-signer.port';

const CONFIG: OrganizationIdentityConfig = {
  organizationId: 'org_sandbox',
  issuer: 'https://sandbox.aihub.example.com',
  jwksUrl: null,
  publicKeysJwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
  allowedAlgorithms: ['RS256'],
  maxAssertionTtlSeconds: 900,
  status: 'active',
};

class RecordingSigner implements SandboxAssertionSignerPort {
  readonly algorithm = 'RS256' as const;
  claims?: SandboxAssertionClaims;

  async sign(claims: SandboxAssertionClaims): Promise<string> {
    this.claims = claims;
    return 'signed.assertion.value';
  }
}

function repository(
  config: OrganizationIdentityConfig | null = CONFIG,
): Pick<
  OrganizationIdentityConfigRepositoryPort,
  'findActiveByOrganizationId'
> {
  return { findActiveByOrganizationId: async () => config };
}

function minter(
  options: {
    readonly config?: OrganizationIdentityConfig | null;
    readonly signer?: SandboxAssertionSignerPort;
  } = {},
) {
  const signer = options.signer ?? new RecordingSigner();
  return {
    signer,
    service: new MintSandboxAssertion(
      repository(options.config === undefined ? CONFIG : options.config),
      signer,
      () => 1_800_000_000,
      () => 'jti_fixed',
    ),
  };
}

function context(organizationId = 'org_sandbox') {
  return createRequestContext({
    requestId: 'req_01M2MNRPCGCT96P54KDBE82MH7',
    receivedAt: new Date(),
    deadlineMs: 5_000,
    organizationId,
    apiKeyId: 'ak_sandbox',
    scopes: [],
  });
}

describe('MintSandboxAssertion', () => {
  it('derives every claim except the end user from configuration', async () => {
    const { service, signer } = minter();

    const minted = await service.mint({
      context: context(),
      userId: 'student_456',
    });

    expect((signer as RecordingSigner).claims).toEqual({
      iss: CONFIG.issuer,
      aud: 'aihub',
      sub: 'student_456',
      jti: 'jti_fixed',
      iat: 1_800_000_000,
      exp: 1_800_000_900,
    });
    expect(minted).toEqual({
      assertion: 'signed.assertion.value',
      userId: 'student_456',
      expiresAt: 1_800_000_900,
      jti: 'jti_fixed',
    });
  });

  it('takes the lifetime from the organization, not from a constant', async () => {
    const { service } = minter({
      config: { ...CONFIG, maxAssertionTtlSeconds: 3_600 },
    });

    const minted = await service.mint({
      context: context(),
      userId: 'student_456',
    });

    expect(minted.expiresAt).toBe(1_800_003_600);
  });

  it.each([
    ['empty', ''],
    ['padded', ' student_456 '],
    ['punctuated', 'student 456'],
    ['injected', 'student\n456'],
    ['oversized', 'a'.repeat(129)],
  ])('rejects a %s end-user identifier', async (_label, userId) => {
    const { service, signer } = minter();

    await expect(
      service.mint({ context: context(), userId }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect((signer as RecordingSigner).claims).toBeUndefined();
  });

  it('refuses to sign with an algorithm the organization does not allow', async () => {
    const { service } = minter({
      config: { ...CONFIG, allowedAlgorithms: ['ES256'] },
    });

    await expect(
      service.mint({ context: context(), userId: 'student_456' }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('reports a missing identity configuration as a server fault', async () => {
    const { service } = minter({ config: null });

    await expect(
      service.mint({ context: context(), userId: 'student_456' }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('surfaces a repository outage as an identity provider failure', async () => {
    const service = new MintSandboxAssertion(
      {
        findActiveByOrganizationId: async (_organizationId: string) => {
          throw new Error('connection refused');
        },
      },
      new RecordingSigner(),
    );

    await expect(
      service.mint({ context: context(), userId: 'student_456' }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});

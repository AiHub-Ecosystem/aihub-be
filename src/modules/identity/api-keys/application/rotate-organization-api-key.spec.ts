import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { ApiKeyCachePort } from './api-key-authenticator.port';
import type {
  OrganizationApiKeyPort,
  OrganizationApiKeyRecord,
  RotateOrganizationApiKeyRecordInput,
  RotateOrganizationApiKeyRecordResult,
} from './organization-api-key.port';
import { RotateOrganizationApiKey } from './rotate-organization-api-key';

const NOW = new Date('2026-10-13T00:00:00.000Z');
const CONTEXT = createRequestContext({
  requestId: 'req_rotate',
  receivedAt: NOW,
  deadlineMs: 5_000,
  scopes: [],
  signal: new AbortController().signal,
});

function createUseCase(allowedEnvironments: readonly string[]) {
  const membership = {
    resolveMembership: async ({
      organizationId,
      userId,
    }: {
      organizationId: string;
      userId: string;
    }) => ({
      kind: 'active' as const,
      membership: {
        organizationId,
        userId,
        organizationStatus: 'active' as const,
        role: 'owner' as const,
        status: 'active' as const,
      },
    }),
  };
  const retired: OrganizationApiKeyRecord = {
    apiKeyId: 'ak_retired',
    name: 'Legacy key',
    keyPrefix: 'aihub_sk_abc123',
    scopes: ['writing.grade'],
    allowedEnvironments,
    status: 'active',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: NOW,
  };
  const recorded: RotateOrganizationApiKeyRecordInput[] = [];
  const apiKeys: Pick<OrganizationApiKeyPort, 'rotateApiKey' | 'listApiKeys'> =
    {
      listApiKeys: async () => [retired],
      rotateApiKey: async (input) => {
        recorded.push(input);
        const result: RotateOrganizationApiKeyRecordResult = {
          kind: 'rotated',
          retiredKeyHash: 'a'.repeat(64),
          name: retired.name,
          scopes: retired.scopes,
          allowedEnvironments: input.replacementAllowedEnvironments,
          expiresAt: retired.expiresAt,
          createdAt: NOW,
        };
        return result;
      },
    };
  const cache: Pick<ApiKeyCachePort, 'delete'> = {
    delete: async () => undefined,
  };

  return {
    useCase: new RotateOrganizationApiKey(
      membership,
      apiKeys,
      cache,
      () => NOW,
    ),
    recorded,
  };
}

describe('RotateOrganizationApiKey', () => {
  it('binds a legacy multi-environment replacement to its first stored environment', async () => {
    const { useCase, recorded } = createUseCase(['production', 'sandbox']);

    const replacement = await useCase.rotate({
      context: CONTEXT,
      userId: 'usr_owner',
      organizationId: 'org_acme',
      apiKeyId: 'ak_retired',
    });

    expect(replacement.apiKey).toMatch(/^aihub_prod_[A-Za-z0-9]{43}$/);
    expect(replacement.allowedEnvironments).toEqual(['production']);
    expect(recorded[0]?.retiredAllowedEnvironments).toEqual([
      'production',
      'sandbox',
    ]);
    expect(recorded[0]?.replacementAllowedEnvironments).toEqual(['production']);
  });

  it('refuses to rotate a key that stores no environment, issuing nothing', async () => {
    const { useCase, recorded } = createUseCase([]);

    await expect(
      useCase.rotate({
        context: CONTEXT,
        userId: 'usr_owner',
        organizationId: 'org_acme',
        apiKeyId: 'ak_retired',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(recorded).toEqual([]);
  });

  it('keeps a single-environment key in the same environment when rotated', async () => {
    const { useCase } = createUseCase(['sandbox']);

    await expect(
      useCase.rotate({
        context: CONTEXT,
        userId: 'usr_owner',
        organizationId: 'org_acme',
        apiKeyId: 'ak_retired',
      }),
    ).resolves.toMatchObject({
      apiKey: expect.stringMatching(/^aihub_sandbox_[A-Za-z0-9]{43}$/),
      allowedEnvironments: ['sandbox'],
    });
  });
});

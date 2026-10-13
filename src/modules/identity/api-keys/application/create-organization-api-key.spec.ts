import type { RequestContext } from '@/common/request-context/request-context';
import { CreateOrganizationApiKey } from './create-organization-api-key';
import type {
  CreateOrganizationApiKeyRecordInput,
  CreateOrganizationApiKeyRecordResult,
  OrganizationApiKeyPort,
} from './organization-api-key.port';

const CONTEXT = { requestId: 'req_1' } as RequestContext;
const CREATED_AT = new Date('2026-10-13T00:00:00.000Z');

class FakeMembership {
  resolveMembership(): Promise<{
    kind: 'active';
    membership: {
      organizationId: string;
      userId: string;
      organizationStatus: 'active';
      role: 'owner';
      status: 'active';
    };
  }> {
    return Promise.resolve({
      kind: 'active',
      membership: {
        organizationId: 'org_acme',
        userId: 'usr_owner',
        organizationStatus: 'active',
        role: 'owner',
        status: 'active',
      },
    });
  }
}

class FakeApiKeys implements OrganizationApiKeyPort {
  created: CreateOrganizationApiKeyRecordInput[] = [];

  createApiKey(
    input: CreateOrganizationApiKeyRecordInput,
  ): Promise<CreateOrganizationApiKeyRecordResult> {
    this.created.push(input);
    return Promise.resolve({ kind: 'created', createdAt: CREATED_AT });
  }

  listApiKeys() {
    return Promise.resolve([]);
  }

  rotateApiKey() {
    return Promise.resolve({ kind: 'key_not_found' as const });
  }

  revokeApiKey() {
    return Promise.resolve({ kind: 'key_not_found' as const });
  }
}

function createUseCase(apiKeys = new FakeApiKeys()): {
  useCase: CreateOrganizationApiKey;
  apiKeys: FakeApiKeys;
} {
  return {
    useCase: new CreateOrganizationApiKey(
      new FakeMembership(),
      apiKeys,
      () => CREATED_AT,
    ),
    apiKeys,
  };
}

function create(
  useCase: CreateOrganizationApiKey,
  allowedEnvironments?: readonly string[],
): ReturnType<CreateOrganizationApiKey['create']> {
  return useCase.create({
    context: CONTEXT,
    userId: 'usr_owner',
    organizationId: 'org_acme',
    name: 'Demo key',
    scopes: ['writing.grade', 'speaking.grade'],
    ...(allowedEnvironments === undefined ? {} : { allowedEnvironments }),
  });
}

describe('CreateOrganizationApiKey', () => {
  it('issues the credential under the prefix of the environment it is bound to', async () => {
    const { useCase } = createUseCase();

    const created = await create(useCase, ['sandbox']);

    expect(created.apiKey).toMatch(/^aihub_sandbox_[A-Za-z0-9]{43}$/);
    expect(created.allowedEnvironments).toEqual(['sandbox']);
  });

  it('binds a new key to exactly one environment', async () => {
    const { useCase } = createUseCase();

    await expect(
      create(useCase, ['production', 'staging']),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('collapses a repeated environment to the single environment it names', async () => {
    const { useCase } = createUseCase();

    await expect(
      create(useCase, ['sandbox', 'sandbox']),
    ).resolves.toMatchObject({ allowedEnvironments: ['sandbox'] });
  });

  it('binds a key with no stated environment to Production', async () => {
    const { useCase, apiKeys } = createUseCase();

    const created = await create(useCase);

    expect(created.allowedEnvironments).toEqual(['production']);
    expect(apiKeys.created[0]?.allowedEnvironments).toEqual(['production']);
  });

  it('refuses a Sandbox key carrying a scope outside the demo pair', async () => {
    const { useCase } = createUseCase();

    await expect(
      useCase.create({
        context: CONTEXT,
        userId: 'usr_owner',
        organizationId: 'org_acme',
        name: 'Sandbox key',
        scopes: ['writing.grade', 'org.read'],
        allowedEnvironments: ['sandbox'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('never persists the raw credential', async () => {
    const { useCase, apiKeys } = createUseCase();

    const created = await create(useCase, ['sandbox']);

    expect(apiKeys.created[0]?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKeys.created[0]?.keyHash).not.toContain(created.apiKey);
  });
});

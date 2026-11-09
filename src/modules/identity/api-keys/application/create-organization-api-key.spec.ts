import { createRequestContext } from '@/common/request-context/request-context.factory';
import { CreateOrganizationApiKey } from './create-organization-api-key';
import type {
  CreateOrganizationApiKeyRecordInput,
  CreateOrganizationApiKeyRecordResult,
  OrganizationApiKeyPort,
} from './organization-api-key.port';

const CREATED_AT = new Date('2026-10-13T00:00:00.000Z');
const CONTEXT = createRequestContext({
  requestId: 'req_1',
  receivedAt: CREATED_AT,
  deadlineMs: 5_000,
  scopes: [],
  signal: new AbortController().signal,
});

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
  it.each([
    '   ',
    'Demo\nkey',
    'Demo \u202Eyek',
    'Demo\u2028key',
    'Demo\u200Bkey',
  ])(
    'refuses the name %j, which is blank or does not show as written',
    async (name) => {
      const { useCase, apiKeys } = createUseCase();
      const created = jest.spyOn(apiKeys, 'createApiKey');

      await expect(
        useCase.create({
          context: CONTEXT,
          userId: 'usr_owner',
          organizationId: 'org_acme',
          name,
          scopes: ['writing.grade'],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(created).not.toHaveBeenCalled();
    },
  );

  it('issues the credential under the prefix of the environment it is bound to', async () => {
    const { useCase } = createUseCase();

    const created = await create(useCase, ['sandbox']);

    expect(created.apiKey).toMatch(/^aihub_sandbox_[A-Za-z0-9]{43}$/);
    expect(created.allowedEnvironments).toEqual(['sandbox']);
  });

  it('allows a Writing exercise scope on a customer Sandbox key', async () => {
    const { useCase, apiKeys } = createUseCase();

    const created = await useCase.create({
      context: CONTEXT,
      userId: 'usr_owner',
      organizationId: 'org_acme',
      name: 'Writing exercises',
      scopes: ['writing.exercise'],
      allowedEnvironments: ['sandbox'],
    });

    expect(created.scopes).toEqual(['writing.exercise']);
    expect(apiKeys.created[0]?.scopes).toEqual(['writing.exercise']);
  });

  it('binds a new key to exactly one environment', async () => {
    const { useCase } = createUseCase();

    await expect(
      create(useCase, ['production', 'staging']),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('does not issue new customer keys for Staging', async () => {
    const { useCase } = createUseCase();

    await expect(create(useCase, ['staging'])).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('collapses a repeated environment to the single environment it names', async () => {
    const { useCase } = createUseCase();

    await expect(
      create(useCase, ['sandbox', 'sandbox']),
    ).resolves.toMatchObject({ allowedEnvironments: ['sandbox'] });
  });

  it('refuses a request that states no environment', async () => {
    const { useCase, apiKeys } = createUseCase();

    // #447: the environment is part of the credential's authority, so the
    // caller states it instead of receiving a Production default.
    await expect(create(useCase)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(apiKeys.created).toHaveLength(0);
  });

  it('refuses a Sandbox key carrying a scope outside the AI service scopes', async () => {
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

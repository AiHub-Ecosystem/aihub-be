import type { PrismaClient } from '@prisma-client/client';
import { PostgresOrganizationCreateRepository } from './postgres-organization-create.repository';

interface CreatedRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly entitlements: string[];
  readonly rateLimitRpm: number;
  readonly maxConcurrent: number;
  readonly monthlyRequestQuota: number | null;
  readonly hardStopOnQuota: boolean;
}

function fakeClient(createImpl?: (data: unknown) => Promise<unknown>) {
  const created: CreatedRecord[] = [];
  let closed = false;

  const transaction = {
    $queryRawUnsafe: async () => [],
    organization: {
      create: async ({ data }: { data: CreatedRecord }) => {
        if (createImpl) return createImpl(data);
        created.push(data);
        return { id: data.id };
      },
    },
  };

  const client = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(transaction),
    close: async () => {
      closed = true;
    },
  };

  return {
    client: client as unknown as PrismaClient & { close(): Promise<void> },
    created,
    isClosed: () => closed,
  };
}

describe('PostgresOrganizationCreateRepository', () => {
  it('creates an organization with provided values', async () => {
    const { client, created, isClosed } = fakeClient();
    const repository = new PostgresOrganizationCreateRepository(client);

    const result = await repository.createOrganization({
      id: 'org_01J8TEST000000000000000001',
      name: 'Acme Corp',
      entitlements: ['writing', 'speaking'],
      rateLimitRpm: 1200,
      maxConcurrent: 50,
      monthlyRequestQuota: 5000,
      hardStopOnQuota: true,
    });

    expect(result).toEqual({
      kind: 'created',
      id: 'org_01J8TEST000000000000000001',
    });
    expect(created).toEqual([
      {
        id: 'org_01J8TEST000000000000000001',
        name: 'Acme Corp',
        status: 'active',
        entitlements: ['writing', 'speaking'],
        rateLimitRpm: 1200,
        maxConcurrent: 50,
        monthlyRequestQuota: 5000,
        hardStopOnQuota: true,
      },
    ]);

    await repository.close();
    expect(isClosed()).toBe(true);
  });

  it('maps store errors through identityStoreUnavailable', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('database connection lost');
    });
    const repository = new PostgresOrganizationCreateRepository(client);

    await expect(
      repository.createOrganization({
        id: 'org_fail',
        name: 'Acme Corp',
        entitlements: ['writing'],
        rateLimitRpm: 600,
        maxConcurrent: 20,
        monthlyRequestQuota: null,
        hardStopOnQuota: false,
      }),
    ).rejects.toThrow('Identity store is unavailable');
  });
});

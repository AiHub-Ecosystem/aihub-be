import type { PrismaClient } from '@prisma-client/client';
import { PostgresOrganizationEntitlementRepository } from './postgres-organization-entitlement.repository';

interface Script {
  /** Answers to the locking reads, in the order the repository issues them. */
  readonly reads: readonly (readonly unknown[])[];
  readonly keyHashes: readonly string[];
}

/**
 * A Prisma-shaped client that answers the raw reads from a script and records
 * what the repository writes, so the grant decision runs in the fast lane. A
 * statement the generated client issues is observed at its model delegate.
 */
function scriptedClient(script: Script) {
  const reads = [...script.reads];
  const rawStatements: (readonly unknown[])[] = [];
  const grants: { id: string; push: string }[] = [];

  const transaction = {
    $queryRawUnsafe: async (_text: string, ...values: unknown[]) => {
      rawStatements.push(values);
      return reads.shift() ?? [];
    },
    $executeRawUnsafe: async (_text: string, ...values: unknown[]) => {
      rawStatements.push(values);
      return 1;
    },
    apiKey: {
      findMany: async () =>
        script.keyHashes.map((hash) => ({ keyHash: Buffer.from(hash, 'hex') })),
    },
    organization: {
      update: async (args: {
        where: { id: string };
        data: { entitlements: { push: string } };
      }) => {
        grants.push({
          id: args.where.id,
          push: args.data.entitlements.push,
        });
        return {};
      },
    },
  };

  const client = {
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(transaction),
    close: async () => undefined,
  };

  return {
    client: client as unknown as PrismaClient & { close(): Promise<void> },
    rawStatements,
    grants,
  };
}

const INPUT = {
  organizationId: 'org_acme',
  actorUsername: 'ops',
  entitlement: 'speaking',
  requestId: 'req_01J00000000000000000000002',
  occurredAt: new Date('2026-09-23T10:00:00Z'),
};

describe('PostgresOrganizationEntitlementRepository', () => {
  it('appends once and audits in the same transaction, returning key hashes for cache purge', async () => {
    const { client, rawStatements, grants } = scriptedClient({
      reads: [
        [{ id: 'usr_ops' }],
        [{ name: 'Acme', entitlements: ['writing'] }],
      ],
      keyHashes: ['abc123'],
    });
    const repository = new PostgresOrganizationEntitlementRepository(client);

    await expect(repository.grantEntitlement(INPUT)).resolves.toEqual({
      kind: 'granted',
      keyHashes: ['abc123'],
    });

    expect(grants).toEqual([{ id: 'org_acme', push: 'speaking' }]);
    // The actor lookup, the Organization lock, then the audit event.
    expect(rawStatements).toHaveLength(3);
    expect(rawStatements[2]?.[3]).toBe('organization.entitlement_granted');
    expect(rawStatements[2]?.[8]).toBe(
      JSON.stringify({ entitlement: 'speaking' }),
    );
  });

  it('does not append or audit an entitlement already present', async () => {
    const { client, rawStatements, grants } = scriptedClient({
      reads: [
        [{ id: 'usr_ops' }],
        [{ name: 'Acme', entitlements: ['writing', 'speaking'] }],
      ],
      keyHashes: [],
    });
    const repository = new PostgresOrganizationEntitlementRepository(client);

    await expect(repository.grantEntitlement(INPUT)).resolves.toEqual({
      kind: 'unchanged',
      keyHashes: [],
    });

    expect(grants).toEqual([]);
    expect(rawStatements).toHaveLength(2);
  });
});

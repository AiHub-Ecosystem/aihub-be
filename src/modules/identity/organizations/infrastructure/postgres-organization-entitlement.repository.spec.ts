import type { PostgresIdentityTransactionalClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { PostgresOrganizationEntitlementRepository } from './postgres-organization-entitlement.repository';

describe('PostgresOrganizationEntitlementRepository', () => {
  it('appends once and audits in the same transaction, returning key hashes for cache purge', async () => {
    const calls: (readonly unknown[])[] = [];
    const responses: readonly unknown[][] = [
      [{ id: 'usr_ops' }],
      [{ name: 'Acme', entitlements: ['writing'] }],
      [{ hash_hex: 'abc123' }],
      [],
      [],
    ];
    const client: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    } = {
      async query() {
        return [];
      },
      async transaction(callback) {
        return callback({
          async query(_text, values) {
            calls.push(values);
            return responses[calls.length - 1] ?? [];
          },
        });
      },
      async close() {},
    };
    const repository = new PostgresOrganizationEntitlementRepository(client);

    await expect(
      repository.grantEntitlement({
        organizationId: 'org_acme',
        actorUsername: 'ops',
        entitlement: 'speaking',
        requestId: 'req_01J00000000000000000000002',
        occurredAt: new Date('2026-09-23T10:00:00Z'),
      }),
    ).resolves.toEqual({ kind: 'granted', keyHashes: ['abc123'] });

    expect(calls).toHaveLength(5);
    expect(calls[3]).toEqual(['org_acme', 'speaking']);
    expect(calls[4]?.[3]).toBe('organization.entitlement_granted');
    expect(calls[4]?.[8]).toBe(JSON.stringify({ entitlement: 'speaking' }));
  });

  it('does not append or audit an entitlement already present', async () => {
    const calls: (readonly unknown[])[] = [];
    const responses: readonly unknown[][] = [
      [{ id: 'usr_ops' }],
      [{ name: 'Acme', entitlements: ['writing', 'speaking'] }],
      [],
    ];
    const client: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    } = {
      async query() {
        return [];
      },
      async transaction(callback) {
        return callback({
          async query(_text, values) {
            calls.push(values);
            return responses[calls.length - 1] ?? [];
          },
        });
      },
      async close() {},
    };
    const repository = new PostgresOrganizationEntitlementRepository(client);

    await expect(
      repository.grantEntitlement({
        organizationId: 'org_acme',
        actorUsername: 'ops',
        entitlement: 'speaking',
        requestId: 'req_01J00000000000000000000002',
        occurredAt: new Date('2026-09-23T10:00:00Z'),
      }),
    ).resolves.toEqual({ kind: 'unchanged', keyHashes: [] });
    expect(calls).toHaveLength(3);
  });
});

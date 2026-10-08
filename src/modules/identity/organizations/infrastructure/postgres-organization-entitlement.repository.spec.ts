import type { PostgresIdentityTransactionalClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { PostgresOrganizationEntitlementRepository } from './postgres-organization-entitlement.repository';

describe('PostgresOrganizationEntitlementRepository', () => {
  it('appends once and audits in the same transaction, returning key hashes for cache purge', async () => {
    const statements: { text: string; values: readonly unknown[] }[] = [];
    const client: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    } = {
      async query() {
        return [];
      },
      async transaction(callback) {
        return callback({
          async query(text, values) {
            statements.push({ text, values });
            if (text.includes('FROM user_accounts')) return [{ id: 'usr_ops' }];
            if (text.includes('FOR UPDATE'))
              return [{ name: 'Acme', entitlements: ['writing'] }];
            if (text.includes('FROM api_keys')) return [{ hash_hex: 'abc123' }];
            return [];
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

    const update = statements.find(({ text }) => text.includes('array_append'));
    expect(update?.values).toEqual(['org_acme', 'speaking']);
    const audit = statements.find(({ text }) =>
      text.includes('INSERT INTO organization_audit_events'),
    );
    expect(audit?.values[3]).toBe('organization.entitlement_granted');
    expect(audit?.values[8]).toBe(JSON.stringify({ entitlement: 'speaking' }));
  });

  it('does not append or audit an entitlement already present', async () => {
    const statements: string[] = [];
    const client: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    } = {
      async query() {
        return [];
      },
      async transaction(callback) {
        return callback({
          async query(text) {
            statements.push(text);
            if (text.includes('FROM user_accounts')) return [{ id: 'usr_ops' }];
            if (text.includes('FOR UPDATE'))
              return [{ name: 'Acme', entitlements: ['writing', 'speaking'] }];
            return [];
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
    expect(statements.some((text) => text.includes('array_append'))).toBe(
      false,
    );
    expect(
      statements.some((text) =>
        text.includes('INSERT INTO organization_audit_events'),
      ),
    ).toBe(false);
  });
});

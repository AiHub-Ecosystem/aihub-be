import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { generateOrganizationApiKey } from '@/modules/identity/application/organization-api-key-generator';
import type { SetOrganizationStatusInput } from '@/modules/identity/application/organization-status.port';
import { PostgresApiKeyRepository } from '@/modules/identity/infrastructure/postgres-api-key.repository';
import {
  type IdentityDrizzleClient,
  type PostgresIdentityTransactionalClient,
  createIdentityDrizzleClient,
  createPostgresIdentityClient,
} from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationStatusRepository } from '@/modules/identity/infrastructure/postgres-organization-status.repository';

import { createTestPool, resetIdentityTables } from './database';

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOrganizationStatusRepository;
let apiKeyStore: IdentityDrizzleClient;
let apiKeys: PostgresApiKeyRepository;

beforeAll(() => {
  pool = createTestPool();
  const url =
    (pool.options as { connectionString?: string }).connectionString ?? '';
  client = createPostgresIdentityClient(url);
  apiKeyStore = createIdentityDrizzleClient(url);
  repository = new PostgresOrganizationStatusRepository(client);
  apiKeys = new PostgresApiKeyRepository(apiKeyStore);
});

afterAll(async () => {
  await apiKeyStore.close();
  await client.close();
  await pool.end();
});

let organizationId: string;
let ownerId: string;
let operatorId: string;
let keyHashes: string[];

async function seedAccount(
  username: string,
  status: 'active' | 'disabled' = 'active',
): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [id, username, status],
  );
  return id;
}

async function seedKey(status: 'active' | 'revoked'): Promise<string> {
  const key = generateOrganizationApiKey();
  await pool.query(
    `INSERT INTO api_keys
       (id, organization_id, key_hash, key_prefix, name, scopes,
        allowed_environments, status)
     VALUES ($1, $2, decode($3, 'hex'), $4, $5, ARRAY['writing.grade'],
             ARRAY['production'], $6)`,
    [key.id, organizationId, key.hash, key.prefix, `key ${key.id}`, status],
  );
  return key.hash;
}

beforeEach(async () => {
  await resetIdentityTables(pool);
  organizationId = `org_${ulid()}`;
  await pool.query(
    `INSERT INTO organizations
       (id, name, entitlements, rate_limit_rpm, max_concurrent,
        monthly_request_quota, hard_stop_on_quota)
     VALUES ($1, 'Acme', ARRAY['writing'], 60, 5, 100, true)`,
    [organizationId],
  );
  ownerId = await seedAccount('acme-owner');
  operatorId = await seedAccount('aihub-ops-alice');
  await pool.query(
    `INSERT INTO organization_members
       (organization_id, user_account_id, role, status)
     VALUES ($1, $2, 'owner', 'active')`,
    [organizationId, ownerId],
  );
  await pool.query(
    `INSERT INTO organization_invitations
       (id, organization_id, email, role, invited_by, token_hash, expires_at,
        created_at)
     VALUES ($1, $2, 'invitee@example.com', 'member', $3, $4,
             now() + interval '1 day', now())`,
    [`oiv_${ulid()}`, organizationId, ownerId, 'a'.repeat(64)],
  );
  keyHashes = [await seedKey('active'), await seedKey('revoked')];
});

function input(
  overrides: Partial<SetOrganizationStatusInput> = {},
): SetOrganizationStatusInput {
  return {
    organizationId,
    actorUsername: 'aihub-ops-alice',
    status: 'suspended',
    requestId: `req_${ulid()}`,
    occurredAt: new Date(),
    ...overrides,
  };
}

async function snapshot(): Promise<unknown> {
  const [organization, keys, members, invitations] = await Promise.all([
    pool.query(
      `SELECT name, status, entitlements, rate_limit_rpm, max_concurrent,
              monthly_request_quota, hard_stop_on_quota
       FROM organizations WHERE id = $1`,
      [organizationId],
    ),
    pool.query(
      'SELECT id, status, revoked_at FROM api_keys WHERE organization_id = $1 ORDER BY id',
      [organizationId],
    ),
    pool.query(
      'SELECT user_account_id, role, status FROM organization_members WHERE organization_id = $1',
      [organizationId],
    ),
    pool.query(
      'SELECT id, consumed_at, expires_at FROM organization_invitations WHERE organization_id = $1',
      [organizationId],
    ),
  ]);
  return {
    organization: organization.rows,
    keys: keys.rows,
    members: members.rows,
    invitations: invitations.rows,
  };
}

async function events(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT actor_user_account_id, action, outcome, target_type, target_id,
            target_label, detail, request_id
     FROM organization_audit_events
     WHERE organization_id = $1
     ORDER BY id`,
    [organizationId],
  );
  return result.rows;
}

async function authenticatedOrganizationStatus(): Promise<string | undefined> {
  const [activeKeyHash] = keyHashes;
  if (activeKeyHash === undefined) {
    throw new Error('no key seeded');
  }
  return (await apiKeys.findByHash(activeKeyHash))?.organizationStatus;
}

describe('Organization suspension against PostgreSQL', () => {
  it('suspends, records the operator as actor, and returns every key of the Organization', async () => {
    const requestId = `req_${ulid()}`;

    const result = await repository.setOrganizationStatus(input({ requestId }));

    expect(result.kind).toBe('changed');
    expect(result).toHaveProperty(
      'keyHashes',
      expect.arrayContaining(keyHashes),
    );
    expect(await authenticatedOrganizationStatus()).toBe('suspended');
    expect(await events()).toEqual([
      {
        actor_user_account_id: operatorId,
        action: 'organization.suspended',
        outcome: 'applied',
        target_type: 'organization',
        target_id: organizationId,
        target_label: 'Acme',
        detail: {},
        request_id: requestId,
      },
    ]);
  });

  it('restores to exactly the state held before suspension', async () => {
    const before = await snapshot();

    await repository.setOrganizationStatus(input());
    await expect(
      repository.setOrganizationStatus(input({ status: 'active' })),
    ).resolves.toMatchObject({ kind: 'changed' });

    expect(await snapshot()).toEqual(before);
    expect(await authenticatedOrganizationStatus()).toBe('active');
    expect((await events()).map((event) => event.action)).toEqual([
      'organization.suspended',
      'organization.restored',
    ]);
  });

  it('answers a repeat as unchanged, still returning the keys, and records nothing', async () => {
    await expect(
      repository.setOrganizationStatus(input({ status: 'active' })),
    ).resolves.toEqual({
      kind: 'unchanged',
      keyHashes: expect.arrayContaining(keyHashes),
    });
    await repository.setOrganizationStatus(input());
    await expect(
      repository.setOrganizationStatus(input()),
    ).resolves.toMatchObject({ kind: 'unchanged' });

    expect(await events()).toHaveLength(1);
  });

  it.each([
    ['an unknown username', 'nobody-here'],
    ['a disabled account', 'aihub-ops-disabled'],
  ])('refuses %s as actor without writing anything', async (_, username) => {
    await seedAccount('aihub-ops-disabled', 'disabled');
    const before = await snapshot();

    await expect(
      repository.setOrganizationStatus(input({ actorUsername: username })),
    ).resolves.toEqual({ kind: 'actor_invalid' });

    expect(await snapshot()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it('refuses an unknown Organization without writing anything', async () => {
    await expect(
      repository.setOrganizationStatus(
        input({ organizationId: `org_${ulid()}` }),
      ),
    ).resolves.toEqual({ kind: 'organization_not_found' });
    expect(await events()).toEqual([]);
  });
});

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import type {
  CreateOperatorApiKeyInput,
  RevokeOperatorApiKeyInput,
} from '@/modules/identity/api-keys/application/operator-api-key.port';
import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import { PostgresOperatorApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-operator-api-key.repository';
import {
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

import { createTestPool, resetIdentityTables } from './database';

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOperatorApiKeyRepository;

beforeAll(() => {
  pool = createTestPool();
  const url =
    (pool.options as { connectionString?: string }).connectionString ?? '';
  client = createPostgresIdentityClient(url);
  repository = new PostgresOperatorApiKeyRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

let organizationId: string;
let operatorId: string;

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

async function seedOrganization(status: 'active' | 'suspended' = 'active') {
  const id = `org_${ulid()}`;
  await pool.query(
    `INSERT INTO organizations
       (id, name, entitlements, rate_limit_rpm, max_concurrent,
        monthly_request_quota, hard_stop_on_quota, status)
     VALUES ($1, 'Acme', ARRAY['writing'], 60, 5, 100, true, $2)`,
    [id, status],
  );
  return id;
}

beforeEach(async () => {
  await resetIdentityTables(pool);
  organizationId = await seedOrganization();
  operatorId = await seedAccount('aihub-ops-alice');
});

function createInput(
  overrides: Partial<CreateOperatorApiKeyInput> = {},
): CreateOperatorApiKeyInput {
  const key = generateOrganizationApiKey();
  return {
    organizationId,
    actorUsername: 'aihub-ops-alice',
    apiKeyId: key.id,
    keyHash: key.hash,
    keyPrefix: key.prefix,
    name: 'Prod backend',
    scopes: ['writing.grade'],
    allowedEnvironments: ['production'],
    requestId: `req_${ulid()}`,
    occurredAt: new Date(),
    ...overrides,
  };
}

function revokeInput(
  apiKeyId: string,
  overrides: Partial<RevokeOperatorApiKeyInput> = {},
): RevokeOperatorApiKeyInput {
  return {
    apiKeyId,
    actorUsername: 'aihub-ops-alice',
    requestId: `req_${ulid()}`,
    occurredAt: new Date(),
    ...overrides,
  };
}

async function keys(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    'SELECT id, status, revoked_at FROM api_keys ORDER BY id',
  );
  return result.rows;
}

async function events(action?: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT organization_id, actor_user_account_id, action, outcome,
            target_type, target_id, target_label, detail, request_id
     FROM organization_audit_events
     WHERE ($1::text IS NULL OR action = $1)
     ORDER BY id`,
    [action ?? null],
  );
  return result.rows;
}

describe('operator API key issuance against PostgreSQL', () => {
  it('inserts the key and records api_key.created with the operator as actor', async () => {
    const input = createInput();

    await expect(repository.createApiKey(input)).resolves.toEqual({
      kind: 'created',
    });

    expect(await keys()).toEqual([
      { id: input.apiKeyId, status: 'active', revoked_at: null },
    ]);
    expect(await events()).toEqual([
      {
        organization_id: organizationId,
        actor_user_account_id: operatorId,
        action: 'api_key.created',
        outcome: 'applied',
        target_type: 'api_key',
        target_id: input.apiKeyId,
        target_label: 'Prod backend',
        detail: {
          keyPrefix: input.keyPrefix,
          scopes: ['writing.grade'],
          allowedEnvironments: ['production'],
        },
        request_id: input.requestId,
      },
    ]);
  });

  it('never puts a key hash in the event', async () => {
    const input = createInput();
    await repository.createApiKey(input);

    expect(JSON.stringify(await events())).not.toContain(input.keyHash);
  });

  it.each([
    ['an unknown username', 'nobody-here'],
    ['a disabled account', 'aihub-ops-disabled'],
  ])('refuses %s as actor without writing anything', async (_, username) => {
    await seedAccount('aihub-ops-disabled', 'disabled');

    await expect(
      repository.createApiKey(createInput({ actorUsername: username })),
    ).resolves.toEqual({ kind: 'actor_invalid' });

    expect(await keys()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it.each([
    ['an unknown Organization', () => Promise.resolve(`org_${ulid()}`)],
    ['a suspended Organization', () => seedOrganization('suspended')],
  ])('refuses %s without writing anything', async (_, organization) => {
    await expect(
      repository.createApiKey(
        createInput({ organizationId: await organization() }),
      ),
    ).resolves.toEqual({ kind: 'organization_unavailable' });

    expect(await keys()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('leaves no key behind when the event cannot be written', async () => {
    // An instant that cannot be stored fails the event write after the key
    // insert has already run inside the same transaction.
    await expect(
      repository.createApiKey(
        createInput({ occurredAt: new Date(Number.NaN) }),
      ),
    ).rejects.toThrow('Identity store is unavailable');

    expect(await keys()).toEqual([]);
    expect(await events()).toEqual([]);
  });
});

describe('operator API key revocation against PostgreSQL', () => {
  async function issue(): Promise<{
    id: string;
    hash: string;
    prefix: string;
  }> {
    const input = createInput();
    await repository.createApiKey(input);
    return { id: input.apiKeyId, hash: input.keyHash, prefix: input.keyPrefix };
  }

  it('revokes, records api_key.revoked, and returns the key hash for the purge', async () => {
    const key = await issue();
    const input = revokeInput(key.id);

    await expect(repository.revokeApiKey(input)).resolves.toEqual({
      kind: 'revoked',
      keyHash: key.hash,
    });

    expect(await keys()).toEqual([
      { id: key.id, status: 'revoked', revoked_at: input.occurredAt },
    ]);
    expect(await events('api_key.revoked')).toEqual([
      {
        organization_id: organizationId,
        actor_user_account_id: operatorId,
        action: 'api_key.revoked',
        outcome: 'applied',
        target_type: 'api_key',
        target_id: key.id,
        target_label: 'Prod backend',
        detail: { keyPrefix: key.prefix },
        request_id: input.requestId,
      },
    ]);
  });

  it('answers a repeat as unchanged, still returning the hash, and records nothing', async () => {
    const key = await issue();
    const first = revokeInput(key.id);
    await repository.revokeApiKey(first);

    await expect(repository.revokeApiKey(revokeInput(key.id))).resolves.toEqual(
      { kind: 'unchanged', keyHash: key.hash },
    );

    expect(await events('api_key.revoked')).toHaveLength(1);
    expect(await keys()).toEqual([
      { id: key.id, status: 'revoked', revoked_at: first.occurredAt },
    ]);
  });

  it('revokes a key of a suspended Organization', async () => {
    const key = await issue();
    await pool.query("UPDATE organizations SET status = 'suspended'");

    await expect(
      repository.revokeApiKey(revokeInput(key.id)),
    ).resolves.toMatchObject({ kind: 'revoked' });

    expect(await events('api_key.revoked')).toHaveLength(1);
  });

  it.each([
    ['an unknown username', 'nobody-here'],
    ['a disabled account', 'aihub-ops-disabled'],
  ])('refuses %s as actor without changing the key', async (_, username) => {
    await seedAccount('aihub-ops-disabled', 'disabled');
    const key = await issue();

    await expect(
      repository.revokeApiKey(revokeInput(key.id, { actorUsername: username })),
    ).resolves.toEqual({ kind: 'actor_invalid' });

    expect(await keys()).toEqual([
      { id: key.id, status: 'active', revoked_at: null },
    ]);
    expect(await events('api_key.revoked')).toEqual([]);
  });

  it('refuses an unknown key without writing anything', async () => {
    await expect(
      repository.revokeApiKey(revokeInput(`ak_${ulid()}`)),
    ).resolves.toEqual({ kind: 'key_not_found' });

    expect(await events('api_key.revoked')).toEqual([]);
  });
});

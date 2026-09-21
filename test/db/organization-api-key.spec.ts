import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '../../src/common/request-context/request-context.factory';
import type { CreateOrganizationApiKeyRecordResult } from '../../src/modules/identity/application/organization-api-key.port';
import { generateApiKey } from '../../src/modules/identity/domain/api-key';
import { PostgresApiKeyRepository } from '../../src/modules/identity/infrastructure/postgres-api-key.repository';
import type { PostgresIdentityTransactionalClient } from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { createPostgresIdentityClient } from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationApiKeyRepository } from '../../src/modules/identity/infrastructure/postgres-organization-api-key.repository';

import {
  createTestPool,
  resetIdentityTables,
  waitForBlockedBy,
} from './database';

const ORGANIZATION_ID = 'org_acme';

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOrganizationApiKeyRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(
    (pool.options as { connectionString?: string }).connectionString ?? '',
  );
  repository = new PostgresOrganizationApiKeyRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

async function seedOrganization(
  options: {
    readonly status?: 'active' | 'suspended';
    readonly entitlements?: readonly string[];
  } = {},
): Promise<void> {
  const { status = 'active', entitlements = ['writing'] } = options;
  await pool.query(
    'INSERT INTO organizations (id, name, status, entitlements) VALUES ($1, $2, $3, $4)',
    [ORGANIZATION_ID, 'Acme', status, [...entitlements]],
  );
}

function create(
  options: {
    readonly apiKeyId?: string;
    readonly activeKeyLimit?: number;
    readonly requiredEntitlements?: readonly string[];
    readonly expiresAt?: Date | null;
  } = {},
): Promise<CreateOrganizationApiKeyRecordResult> {
  const generated = generateApiKey();
  return repository.createApiKey({
    context: createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: new Date(),
      deadlineMs: 5_000,
      organizationId: ORGANIZATION_ID,
      userId: `usr_${ulid()}`,
      scopes: [],
    }),
    organizationId: ORGANIZATION_ID,
    apiKeyId: options.apiKeyId ?? generated.id,
    keyHash: generated.hash,
    keyPrefix: generated.prefix,
    name: 'Prod backend',
    scopes: ['writing.grade'],
    allowedEnvironments: ['production'],
    expiresAt: options.expiresAt ?? null,
    requiredEntitlements: options.requiredEntitlements ?? ['writing'],
    activeKeyLimit: options.activeKeyLimit ?? 50,
  });
}

async function keyCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM api_keys WHERE organization_id = $1',
    [ORGANIZATION_ID],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('organization API key creation against PostgreSQL', () => {
  it('persists the key and returns the durable creation timestamp', async () => {
    await seedOrganization();

    const result = await create();

    expect(result.kind).toBe('created');
    expect(await keyCount()).toBe(1);
  });

  it('stores a hash the authentication lookup can find again', async () => {
    await seedOrganization();
    const generated = generateApiKey();

    await repository.createApiKey({
      context: createRequestContext({
        requestId: `req_${ulid()}`,
        receivedAt: new Date(),
        deadlineMs: 5_000,
        organizationId: ORGANIZATION_ID,
        userId: `usr_${ulid()}`,
        scopes: [],
      }),
      organizationId: ORGANIZATION_ID,
      apiKeyId: generated.id,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      name: 'Prod backend',
      scopes: ['writing.grade'],
      allowedEnvironments: ['production'],
      expiresAt: null,
      requiredEntitlements: ['writing'],
      activeKeyLimit: 50,
    });

    // The two sides encode the same hash differently (hex in, bytea out), so
    // a created key that authentication cannot find is a real failure mode.
    const found = await new PostgresApiKeyRepository(client).findByHash(
      generated.hash,
    );
    expect(found?.apiKeyId).toBe(generated.id);
    expect(found?.organizationId).toBe(ORGANIZATION_ID);
    expect(found?.scopes).toEqual(['writing.grade']);
  });

  it('claims the organization row before counting, so a creation cannot count around a holder', async () => {
    await seedOrganization();
    expect((await create({ activeKeyLimit: 1 })).kind).toBe('created');

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const holderPid = await holder
        .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        .then(({ rows }) => rows[0]?.pid);
      await holder.query(
        'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
        [ORGANIZATION_ID],
      );

      let settled = false;
      const pending = create({ activeKeyLimit: 1 }).then((result) => {
        settled = true;
        return result;
      });

      // The outcome here is `limit_reached`, so this creation never reaches
      // its insert. A repository that counted the organization's keys without
      // first claiming its row would therefore answer immediately and block on
      // nothing, and no backend would ever appear here however slow the runner
      // is. The row's own foreign key cannot stand in for the claim: it is
      // only taken at insert time, which is after the count that decides the
      // limit. Asked of the engine rather than of the clock.
      await waitForBlockedBy(pool, holderPid);
      expect(settled).toBe(false);

      await holder.query('COMMIT');
      expect((await pending).kind).toBe('limit_reached');
      expect(await keyCount()).toBe(1);
    } finally {
      holder.release();
    }
  });

  it('refuses a key once the organization is at its active key limit', async () => {
    await seedOrganization();
    await create({ activeKeyLimit: 1 });

    const result = await create({ activeKeyLimit: 1 });

    expect(result.kind).toBe('limit_reached');
    expect(await keyCount()).toBe(1);
  });

  it('does not count revoked keys against the active key limit', async () => {
    await seedOrganization();
    await create({ activeKeyLimit: 1 });
    await pool.query(
      "UPDATE api_keys SET status = 'revoked', revoked_at = now() WHERE organization_id = $1",
      [ORGANIZATION_ID],
    );

    const result = await create({ activeKeyLimit: 1 });

    expect(result.kind).toBe('created');
  });

  it('persists nothing when the insert fails part-way through', async () => {
    await seedOrganization();
    const first = await create();
    expect(first.kind).toBe('created');
    const existingId = (
      await pool.query<{ id: string }>(
        'SELECT id FROM api_keys WHERE organization_id = $1',
        [ORGANIZATION_ID],
      )
    ).rows[0]?.id as string;

    await expect(create({ apiKeyId: existingId })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });

    expect(await keyCount()).toBe(1);
  });

  it('refuses a key for a suspended organization', async () => {
    await seedOrganization({ status: 'suspended' });

    const result = await create();

    expect(result.kind).toBe('organization_unavailable');
    expect(await keyCount()).toBe(0);
  });

  it('refuses a key for an organization that does not exist', async () => {
    const result = await create();

    expect(result.kind).toBe('organization_unavailable');
  });

  it('refuses a scope whose entitlement the organization does not hold', async () => {
    await seedOrganization({ entitlements: ['writing'] });

    const result = await create({ requiredEntitlements: ['speaking'] });

    expect(result.kind).toBe('entitlements_missing');
    expect(await keyCount()).toBe(0);
  });

  it('admits a key when every required entitlement is held', async () => {
    await seedOrganization({ entitlements: ['writing', 'speaking'] });

    const result = await create({
      requiredEntitlements: ['writing', 'speaking'],
    });

    expect(result.kind).toBe('created');
  });
});

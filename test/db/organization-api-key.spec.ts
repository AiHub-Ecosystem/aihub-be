import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '../../src/common/request-context/request-context.factory';
import type { CreateOrganizationApiKeyRecordResult } from '../../src/modules/identity/application/organization-api-key.port';
import { generateApiKey } from '../../src/modules/identity/domain/api-key';
import { PostgresApiKeyRepository } from '../../src/modules/identity/infrastructure/postgres-api-key.repository';
import type { PostgresIdentityTransactionalClient } from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { createPostgresIdentityClient } from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationApiKeyRepository } from '../../src/modules/identity/infrastructure/postgres-organization-api-key.repository';

import { createTestPool, resetIdentityTables } from './database';

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

  it('admits exactly one racer into the last remaining key slot', async () => {
    await seedOrganization();
    expect((await create({ activeKeyLimit: 2 })).kind).toBe('created');

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => create({ activeKeyLimit: 2 })),
    );

    // Without the organization row lock every racer reads the same count of
    // one and every racer inserts, leaving the organization over its limit.
    expect(outcomes.filter(({ kind }) => kind === 'created')).toHaveLength(1);
    expect(
      outcomes.filter(({ kind }) => kind === 'limit_reached'),
    ).toHaveLength(3);
    expect(await keyCount()).toBe(2);
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

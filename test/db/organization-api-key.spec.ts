import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '../../src/common/request-context/request-context.factory';
import { ApiKeyAuthenticator } from '../../src/modules/identity/application/api-key-authenticator';
import type { ApiKeyCachePort } from '../../src/modules/identity/application/api-key-authenticator.port';
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
const OTHER_ORGANIZATION_ID = 'org_other';

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
    readonly id?: string;
    readonly status?: 'active' | 'suspended';
    readonly entitlements?: readonly string[];
  } = {},
): Promise<void> {
  const {
    id = ORGANIZATION_ID,
    status = 'active',
    entitlements = ['writing'],
  } = options;
  await pool.query(
    'INSERT INTO organizations (id, name, status, entitlements) VALUES ($1, $2, $3, $4)',
    [id, `Organization ${id}`, status, [...entitlements]],
  );
}

function listContext(organizationId: string) {
  return createRequestContext({
    requestId: `req_${ulid()}`,
    receivedAt: new Date(),
    deadlineMs: 5_000,
    organizationId,
    userId: `usr_${ulid()}`,
    scopes: [],
  });
}

async function seedKey(options: {
  readonly organizationId: string;
  readonly name: string;
  readonly status?: 'active' | 'revoked';
  readonly createdAt?: Date;
}): Promise<string> {
  const generated = generateApiKey();
  const { organizationId, name, status = 'active', createdAt } = options;
  await pool.query(
    `INSERT INTO api_keys
       (id, organization_id, key_hash, key_prefix, name, scopes,
        allowed_environments, status, created_at)
     VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6, $7, $8,
             COALESCE($9::timestamptz, now()))`,
    [
      generated.id,
      organizationId,
      generated.hash,
      generated.prefix,
      name,
      ['writing.grade'],
      ['production'],
      status,
      createdAt ?? null,
    ],
  );
  return generated.id;
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

  it('counts only the organization own keys against its active key limit', async () => {
    await seedOrganization();
    await seedOrganization({ id: OTHER_ORGANIZATION_ID });
    await seedKey({ organizationId: OTHER_ORGANIZATION_ID, name: 'theirs' });

    // Another tenant filling its own inventory must not consume this
    // organization's last slot.
    const result = await create({ activeKeyLimit: 1 });

    expect(result.kind).toBe('created');
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

describe('organization API key listing against PostgreSQL', () => {
  it('returns only the caller organization keys when another tenant holds keys too', async () => {
    await seedOrganization();
    await seedOrganization({ id: OTHER_ORGANIZATION_ID });
    await seedKey({ organizationId: ORGANIZATION_ID, name: 'ours' });
    await seedKey({ organizationId: OTHER_ORGANIZATION_ID, name: 'theirs' });

    const keys = await repository.listApiKeys({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
    });

    // The organization predicate is the whole of tenant scoping here, and a
    // substituted repository would satisfy it by construction.
    expect(keys.map(({ name }) => name)).toEqual(['ours']);
  });

  it('leaves revoked keys out of the live inventory', async () => {
    await seedOrganization();
    await seedKey({ organizationId: ORGANIZATION_ID, name: 'live' });
    await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'withdrawn',
      status: 'revoked',
    });

    const keys = await repository.listApiKeys({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
    });

    expect(keys.map(({ name }) => name)).toEqual(['live']);
  });

  it('orders the inventory newest first', async () => {
    await seedOrganization();
    await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'oldest',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'newest',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'middle',
      createdAt: new Date('2026-09-10T00:00:00.000Z'),
    });

    const keys = await repository.listApiKeys({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
    });

    expect(keys.map(({ name }) => name)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
  });

  it('projects the durable columns the management surface publishes', async () => {
    await seedOrganization();
    const id = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'Prod backend',
    });

    const [key] = await repository.listApiKeys({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
    });

    expect(key?.apiKeyId).toBe(id);
    expect(key?.name).toBe('Prod backend');
    expect(key?.keyPrefix).toMatch(/^aihub_sk_[A-Za-z0-9]{6}$/);
    expect(key?.scopes).toEqual(['writing.grade']);
    expect(key?.allowedEnvironments).toEqual(['production']);
    expect(key?.status).toBe('active');
    expect(key?.expiresAt).toBeNull();
    expect(key?.lastUsedAt).toBeNull();
    expect(key?.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(key)).not.toContain('key_hash');
  });

  it('returns an empty inventory for an organization with no keys', async () => {
    await seedOrganization();

    const keys = await repository.listApiKeys({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
    });

    expect(keys).toEqual([]);
  });
});

describe('organization API key rotation against PostgreSQL', () => {
  async function rotate(options: {
    readonly apiKeyId: string;
    readonly organizationId?: string;
    readonly now?: Date;
  }) {
    const replacement = generateApiKey();
    const organizationId = options.organizationId ?? ORGANIZATION_ID;
    return repository.rotateApiKey({
      context: listContext(organizationId),
      organizationId,
      apiKeyId: options.apiKeyId,
      replacementId: replacement.id,
      keyHash: replacement.hash,
      keyPrefix: replacement.prefix,
      now: options.now ?? new Date(),
    });
  }

  /** An empty cache, so the assertion is about durable state, not about Redis. */
  function emptyCache(): ApiKeyCachePort {
    return {
      get: async () => undefined,
      set: async () => undefined,
      setMiss: async () => undefined,
      delete: async () => undefined,
    };
  }

  async function seedKeyWith(options: {
    readonly name: string;
    readonly scopes?: readonly string[];
    readonly environments?: readonly string[];
    readonly expiresAt?: Date | null;
  }) {
    const key = generateApiKey();
    await pool.query(
      `INSERT INTO api_keys
         (id, organization_id, key_hash, key_prefix, name, scopes,
          allowed_environments, expires_at)
       VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6, $7, $8)`,
      [
        key.id,
        ORGANIZATION_ID,
        key.hash,
        key.prefix,
        options.name,
        [...(options.scopes ?? ['writing.grade'])],
        [...(options.environments ?? ['production'])],
        options.expiresAt ?? null,
      ],
    );
    return key;
  }

  it('leaves the retired key refused by a real authenticator', async () => {
    await seedOrganization();
    const retired = await seedKeyWith({ name: 'Prod backend' });

    expect((await rotate({ apiKeyId: retired.id })).kind).toBe('rotated');

    // Asserting the column now reads revoked would prove the column changed.
    // The acceptance criterion is about authentication, and the two coincide
    // only while the authenticator reads that column the way a test assumes.
    const authenticator = new ApiKeyAuthenticator(
      new PostgresApiKeyRepository(client),
      emptyCache(),
      { get: async () => 0, recordFailure: async () => 1 },
    );
    await expect(
      authenticator.authenticate({
        value: retired.raw,
        environment: 'production',
        clientIp: '198.51.100.7',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('gives the replacement every piece of the retired key authority', async () => {
    await seedOrganization({ entitlements: ['writing', 'speaking'] });
    const expiresAt = new Date('2027-03-04T05:06:07.000Z');
    const retired = await seedKeyWith({
      name: 'Prod backend',
      scopes: ['writing.grade', 'speaking.grade'],
      environments: ['production', 'staging'],
      expiresAt,
    });

    const result = await rotate({ apiKeyId: retired.id });

    expect(result).toMatchObject({
      kind: 'rotated',
      name: 'Prod backend',
      scopes: ['writing.grade', 'speaking.grade'],
      allowedEnvironments: ['production', 'staging'],
      expiresAt,
    });
    const keys = await repository.listApiKeys({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.expiresAt).toEqual(expiresAt);
    expect(keys[0]?.scopes).toEqual(['writing.grade', 'speaking.grade']);
    expect(keys[0]?.allowedEnvironments).toEqual(['production', 'staging']);
  });

  it('rotates an organization sitting at its active key limit', async () => {
    await seedOrganization();
    const retired = await seedKeyWith({ name: 'at the cap' });

    // The cap counts active keys, and rotation does not change how many there
    // are. An organization at its cap is exactly the one that must still be
    // able to replace a leaked credential.
    expect((await rotate({ apiKeyId: retired.id })).kind).toBe('rotated');
  });

  it('refuses a key that belongs to another organization, and leaves it alone', async () => {
    await seedOrganization();
    await seedOrganization({ id: OTHER_ORGANIZATION_ID });
    const theirs = await seedKey({
      organizationId: OTHER_ORGANIZATION_ID,
      name: 'theirs',
    });

    const result = await rotate({ apiKeyId: theirs });

    expect(result.kind).toBe('key_not_found');
    const survivor = await pool.query<{ status: string }>(
      'SELECT status FROM api_keys WHERE id = $1',
      [theirs],
    );
    expect(survivor.rows[0]?.status).toBe('active');
  });

  it('refuses an unknown key', async () => {
    await seedOrganization();

    expect((await rotate({ apiKeyId: 'ak_missing' })).kind).toBe(
      'key_not_found',
    );
  });

  it('refuses an already revoked key', async () => {
    await seedOrganization();
    const revoked = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'withdrawn',
      status: 'revoked',
    });

    expect((await rotate({ apiKeyId: revoked })).kind).toBe(
      'key_not_rotatable',
    );
  });

  it('refuses an expired key rather than minting one dead at birth', async () => {
    await seedOrganization();
    const retired = await seedKeyWith({
      name: 'Stale',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await rotate({
      apiKeyId: retired.id,
      now: new Date('2026-09-21T00:00:00.000Z'),
    });

    expect(result.kind).toBe('key_not_rotatable');
    expect(await keyCount()).toBe(1);
  });

  it('refuses rotation for a suspended organization', async () => {
    await seedOrganization({ status: 'suspended' });
    const retired = await seedKeyWith({ name: 'frozen' });

    expect((await rotate({ apiKeyId: retired.id })).kind).toBe(
      'organization_unavailable',
    );
  });

  it('persists nothing when the replacement insert fails part-way through', async () => {
    await seedOrganization();
    const retired = await seedKeyWith({ name: 'original' });
    const collision = await seedKeyWith({ name: 'collision' });
    const replacement = generateApiKey();

    // Reusing an existing identifier makes the insert fail after the old key
    // has already been revoked, so only an atomic rotation leaves it usable.
    await expect(
      repository.rotateApiKey({
        context: listContext(ORGANIZATION_ID),
        organizationId: ORGANIZATION_ID,
        apiKeyId: retired.id,
        replacementId: collision.id,
        keyHash: replacement.hash,
        keyPrefix: replacement.prefix,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    const survivor = await pool.query<{ status: string }>(
      'SELECT status FROM api_keys WHERE id = $1',
      [retired.id],
    );
    expect(survivor.rows[0]?.status).toBe('active');
    expect(await keyCount()).toBe(2);
  });

  it('claims the key row, so a concurrent rotation waits instead of revoking it twice', async () => {
    await seedOrganization();
    const retired = await seedKeyWith({ name: 'contended' });

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const holderPid = await holder
        .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        .then(({ rows }) => rows[0]?.pid);
      await holder.query('SELECT id FROM api_keys WHERE id = $1 FOR UPDATE', [
        retired.id,
      ]);
      // Revoking inside the holder means the rotation waiting behind it finds
      // the key already retired and answers `key_not_rotatable`, so it never
      // reaches an insert. Without that, the `api_keys` foreign key takes its
      // own lock on the organization row at insert time and blocks there
      // whether or not the code claimed the key row first, and this assertion
      // could not tell the two apart.
      await holder.query(
        "UPDATE api_keys SET status = 'revoked', revoked_at = now() WHERE id = $1",
        [retired.id],
      );

      let settled = false;
      const pending = rotate({ apiKeyId: retired.id }).then((result) => {
        settled = true;
        return result;
      });

      await waitForBlockedBy(pool, holderPid);
      expect(settled).toBe(false);

      await holder.query('COMMIT');
      expect((await pending).kind).toBe('key_not_rotatable');
      expect(await keyCount()).toBe(1);
    } finally {
      holder.release();
    }
  });
});

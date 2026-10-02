import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import { ApiKeyAuthenticator } from '@/modules/identity/application/api-key-authenticator';
import type { ApiKeyCachePort } from '@/modules/identity/application/api-key-authenticator.port';
import { generateOrganizationApiKey } from '@/modules/identity/application/organization-api-key-generator';
import type { CreateOrganizationApiKeyRecordResult } from '@/modules/identity/application/organization-api-key.port';
import { PostgresApiKeyRepository } from '@/modules/identity/infrastructure/postgres-api-key.repository';
import type { PostgresIdentityTransactionalClient } from '@/modules/identity/infrastructure/postgres-identity.client';
import { createPostgresIdentityClient } from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationApiKeyRepository } from '@/modules/identity/infrastructure/postgres-organization-api-key.repository';

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

let actorUserId: string;

beforeEach(async () => {
  await resetIdentityTables(pool);
  actorUserId = await seedActor();
});

/**
 * Every key mutation writes an Organization Audit Event naming its actor, and
 * that actor is a real account by foreign key, so the lane seeds one.
 */
async function seedActor(): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`],
  );
  return id;
}

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
    userId: actorUserId,
    scopes: [],
  });
}

async function seedKey(options: {
  readonly organizationId: string;
  readonly name: string;
  readonly status?: 'active' | 'revoked';
  readonly createdAt?: Date;
}): Promise<string> {
  const generated = generateOrganizationApiKey();
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
  const generated = generateOrganizationApiKey();
  return repository.createApiKey({
    context: listContext(ORGANIZATION_ID),
    organizationId: ORGANIZATION_ID,
    actorUserId,
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
    const generated = generateOrganizationApiKey();

    await repository.createApiKey({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
      actorUserId,
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
    const replacement = generateOrganizationApiKey();
    const organizationId = options.organizationId ?? ORGANIZATION_ID;
    return repository.rotateApiKey({
      context: listContext(organizationId),
      organizationId,
      actorUserId,
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
    const key = generateOrganizationApiKey();
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
    const replacement = generateOrganizationApiKey();

    // Reusing an existing identifier makes the insert fail after the old key
    // has already been revoked, so only an atomic rotation leaves it usable.
    await expect(
      repository.rotateApiKey({
        context: listContext(ORGANIZATION_ID),
        organizationId: ORGANIZATION_ID,
        actorUserId,
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

describe('organization API key revocation against PostgreSQL', () => {
  function revoke(options: {
    readonly apiKeyId: string;
    readonly organizationId?: string;
    readonly now?: Date;
  }) {
    const organizationId = options.organizationId ?? ORGANIZATION_ID;
    return repository.revokeApiKey({
      context: listContext(organizationId),
      organizationId,
      actorUserId,
      apiKeyId: options.apiKeyId,
      now: options.now ?? new Date(),
    });
  }

  async function revokedAt(apiKeyId: string): Promise<Date | null> {
    const result = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM api_keys WHERE id = $1',
      [apiKeyId],
    );
    return result.rows[0]?.revoked_at ?? null;
  }

  it('leaves the withdrawn key refused by a real authenticator', async () => {
    await seedOrganization();
    const key = generateOrganizationApiKey();
    await pool.query(
      `INSERT INTO api_keys
         (id, organization_id, key_hash, key_prefix, name, scopes,
          allowed_environments)
       VALUES ($1, $2, decode($3, 'hex'), $4, 'Prod backend',
               ARRAY['writing.grade'], ARRAY['production'])`,
      [key.id, ORGANIZATION_ID, key.hash, key.prefix],
    );

    expect((await revoke({ apiKeyId: key.id })).kind).toBe('revoked');

    // The criterion is about authentication, not about a column: the two
    // coincide only while the authenticator reads that column as assumed.
    const authenticator = new ApiKeyAuthenticator(
      new PostgresApiKeyRepository(client),
      {
        get: async () => undefined,
        set: async () => undefined,
        setMiss: async () => undefined,
        delete: async () => undefined,
      },
      { get: async () => 0, recordFailure: async () => 1 },
    );
    await expect(
      authenticator.authenticate({
        value: key.raw,
        environment: 'production',
        clientIp: '198.51.100.9',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('records the moment the credential stopped working', async () => {
    await seedOrganization();
    const id = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'Prod backend',
    });
    const now = new Date('2026-09-21T11:22:33.000Z');

    await revoke({ apiKeyId: id, now });

    // Nothing observable consults revoked_at — authentication reads only the
    // status — so the column is the only evidence this criterion has.
    expect(await revokedAt(id)).toEqual(now);
  });

  it('keeps the recorded moment when the same key is withdrawn again', async () => {
    await seedOrganization();
    const id = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'Prod backend',
    });
    const first = new Date('2026-09-21T11:22:33.000Z');
    await revoke({ apiKeyId: id, now: first });

    const repeat = await revoke({
      apiKeyId: id,
      now: new Date('2026-09-21T23:59:59.000Z'),
    });

    // The record should say when the credential actually stopped working, not
    // when somebody last asked for it again.
    expect(repeat.kind).toBe('revoked');
    expect(await revokedAt(id)).toEqual(first);
  });

  it('reports a key already withdrawn as withdrawn, with its hash for the purge', async () => {
    await seedOrganization();
    const id = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'withdrawn',
      status: 'revoked',
    });

    const result = await revoke({ apiKeyId: id });

    // The hash has to come back on the repeat too: purging again is the only
    // remedy for a first purge that failed without telling anyone.
    if (result.kind !== 'revoked') {
      throw new Error(`expected a revoked result, got ${result.kind}`);
    }

    expect(result.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.key.status).toBe('revoked');
  });

  it('refuses a key that belongs to another organization, and leaves it alone', async () => {
    await seedOrganization();
    await seedOrganization({ id: OTHER_ORGANIZATION_ID });
    const theirs = await seedKey({
      organizationId: OTHER_ORGANIZATION_ID,
      name: 'theirs',
    });

    expect((await revoke({ apiKeyId: theirs })).kind).toBe('key_not_found');

    const survivor = await pool.query<{ status: string }>(
      'SELECT status FROM api_keys WHERE id = $1',
      [theirs],
    );
    expect(survivor.rows[0]?.status).toBe('active');
  });

  it('refuses an unknown key', async () => {
    await seedOrganization();

    expect((await revoke({ apiKeyId: 'ak_missing' })).kind).toBe(
      'key_not_found',
    );
  });

  it('refuses withdrawal for a suspended organization', async () => {
    await seedOrganization({ status: 'suspended' });
    const id = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'frozen',
    });

    expect((await revoke({ apiKeyId: id })).kind).toBe(
      'organization_unavailable',
    );
    expect(await revokedAt(id)).toBeNull();
  });

  it('withdraws an expired key and frees the cap slot it was holding', async () => {
    await seedOrganization();
    const expired = generateOrganizationApiKey();
    await pool.query(
      `INSERT INTO api_keys
         (id, organization_id, key_hash, key_prefix, name, scopes,
          allowed_environments, expires_at)
       VALUES ($1, $2, decode($3, 'hex'), $4, 'Stale', ARRAY['writing.grade'],
               ARRAY['production'], $5)`,
      [
        expired.id,
        ORGANIZATION_ID,
        expired.hash,
        expired.prefix,
        new Date('2026-01-01T00:00:00.000Z'),
      ],
    );

    expect((await revoke({ apiKeyId: expired.id })).kind).toBe('revoked');

    // An expired key still holds the durable status the cap counts, so an
    // organization that could not withdraw one could be held at its limit by
    // credentials that no longer work.
    const result = await create({ activeKeyLimit: 1 });
    expect(result.kind).toBe('created');
  });

  it('withdraws the last remaining key', async () => {
    await seedOrganization();
    const only = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'the only one',
    });

    expect((await revoke({ apiKeyId: only })).kind).toBe('revoked');

    const remaining = await repository.listApiKeys({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
    });
    expect(remaining).toEqual([]);
    // Holding no keys is escapable, which is what separates it from the
    // zero-owner invariant.
    expect((await create({})).kind).toBe('created');
  });
});

describe('organization API key audit trail against PostgreSQL', () => {
  async function auditEvents(): Promise<
    ReadonlyArray<{
      action: string;
      outcome: string;
      target_id: string;
      target_label: string | null;
      actor_user_account_id: string;
      detail: Record<string, unknown> | null;
    }>
  > {
    const result = await pool.query(
      `SELECT action, outcome, target_id, target_label,
              actor_user_account_id, detail
       FROM organization_audit_events
       WHERE organization_id = $1
       ORDER BY id ASC`,
      [ORGANIZATION_ID],
    );
    return result.rows;
  }

  it('records a creation against the key it created', async () => {
    await seedOrganization();

    await create();

    const [event] = await auditEvents();
    expect(event?.action).toBe('api_key.created');
    expect(event?.outcome).toBe('applied');
    expect(event?.actor_user_account_id).toBe(actorUserId);
    expect(event?.target_label).toBe('Prod backend');
    expect(event?.detail).toMatchObject({ scopes: ['writing.grade'] });
  });

  it('records a rotation naming the replacement beside the key it withdrew', async () => {
    await seedOrganization();
    const retired = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'original',
    });
    const replacement = generateOrganizationApiKey();

    await repository.rotateApiKey({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
      actorUserId,
      apiKeyId: retired,
      replacementId: replacement.id,
      keyHash: replacement.hash,
      keyPrefix: replacement.prefix,
      now: new Date(),
    });

    const [event] = await auditEvents();
    expect(event?.action).toBe('api_key.rotated');
    expect(event?.target_id).toBe(retired);
    expect(event?.detail).toMatchObject({
      replacementId: replacement.id,
      replacementKeyPrefix: replacement.prefix,
    });
    // The withdrawn key is the event's target, so its own prefix is what
    // identifies the record.
    expect(event?.detail).toHaveProperty('keyPrefix');
  });

  it('records the withdrawal once, not again on the repeat that changed nothing', async () => {
    await seedOrganization();
    const key = await seedKey({
      organizationId: ORGANIZATION_ID,
      name: 'Prod backend',
    });

    await repository.revokeApiKey({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
      actorUserId,
      apiKeyId: key,
      now: new Date(),
    });
    await repository.revokeApiKey({
      context: listContext(ORGANIZATION_ID),
      organizationId: ORGANIZATION_ID,
      actorUserId,
      apiKeyId: key,
      now: new Date(),
    });

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('api_key.revoked');
    expect(events[0]?.target_id).toBe(key);
  });

  it('records no credential material', async () => {
    await seedOrganization();
    await create();

    const result = await pool.query<{ row: string }>(
      `SELECT organization_audit_events::text AS row
       FROM organization_audit_events`,
    );
    const rows = result.rows.map(({ row }) => row).join(' ');
    const keys = await pool.query<{ hash: string }>(
      "SELECT encode(key_hash, 'hex') AS hash FROM api_keys",
    );
    for (const { hash } of keys.rows) {
      expect(rows).not.toContain(hash);
    }
  });
});

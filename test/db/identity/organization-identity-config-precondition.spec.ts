import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  IdentityConfigPrecondition,
  SaveOrganizationIdentityConfigInput,
  SaveOrganizationIdentityConfigResult,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { PostgresOrganizationIdentityConfigRepository } from '@/modules/identity/organization-identity-configuration/infrastructure/postgres-organization-identity-config.repository';
import { createPostgresIdentityClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

import { createTestPool, resetIdentityTables } from '../shared/database';

let pool: Pool;
let client: ReturnType<typeof createPostgresIdentityClient>;
let repository: PostgresOrganizationIdentityConfigRepository;
let organizationId: string;
let ownerId: string;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(
    (pool.options as { connectionString?: string }).connectionString ?? '',
  );
  repository = new PostgresOrganizationIdentityConfigRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

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
  ownerId = await seedMember('owner');
});

async function seedMember(role: 'owner' | 'admin'): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`],
  );
  await pool.query(
    `INSERT INTO organization_members
       (organization_id, user_account_id, role, status)
     VALUES ($1, $2, $3, 'active')`,
    [organizationId, id, role],
  );
  return id;
}

function save(
  overrides: Partial<SaveOrganizationIdentityConfigInput> & {
    readonly precondition?: IdentityConfigPrecondition;
  } = {},
): Promise<SaveOrganizationIdentityConfigResult> {
  const userId = overrides.userId ?? ownerId;
  return repository.saveForOwner({
    context: createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: new Date(),
      deadlineMs: 5_000,
      userId,
      scopes: [],
    }),
    userId,
    organizationId,
    issuer: 'https://acme.edu',
    jwksUrl: null,
    publicKeysJwks: {
      keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'rsa-1' }],
    },
    allowedAlgorithms: ['RS256', 'ES256'],
    maxAssertionTtlSeconds: 300,
    sourceKind: 'inline',
    ...overrides,
  });
}

function revisionOf(result: SaveOrganizationIdentityConfigResult): string {
  if (result.kind === 'forbidden' || result.kind === 'precondition_failed') {
    throw new Error(`save answered ${result.kind}`);
  }
  return result.config.revision;
}

async function stored(): Promise<{
  revision: string;
  jwks_cache_version: string;
  issuer: string;
}> {
  const { rows } = await pool.query<{
    revision: string;
    jwks_cache_version: string;
    issuer: string;
  }>(
    `SELECT revision::text, jwks_cache_version::text, issuer
     FROM organization_identity_configs WHERE organization_id = $1`,
    [organizationId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('no configuration row');
  }
  return row;
}

async function auditCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM organization_audit_events
     WHERE organization_id = $1`,
    [organizationId],
  );
  return Number(rows[0]?.count);
}

describe('Organization identity configuration revision and precondition (ADR-0132)', () => {
  it('starts at revision 1, rises on a change, and holds on an identical save', async () => {
    expect(revisionOf(await save())).toBe('1');
    expect(revisionOf(await save({ maxAssertionTtlSeconds: 600 }))).toBe('2');

    const repeated = await save({ maxAssertionTtlSeconds: 600 });

    expect(repeated.kind).toBe('unchanged');
    expect(revisionOf(repeated)).toBe('2');
  });

  it('counts a change back to an earlier content as a new revision', async () => {
    await save({ maxAssertionTtlSeconds: 300 });
    await save({ maxAssertionTtlSeconds: 600 });

    const back = await save({ maxAssertionTtlSeconds: 300 });

    expect(revisionOf(back)).toBe('3');
  });

  it('rises when a change is written outside the owner route', async () => {
    await save();

    await pool.query(
      `UPDATE organization_identity_configs
       SET status = 'disabled' WHERE organization_id = $1`,
      [organizationId],
    );

    expect((await stored()).revision).toBe('2');
  });

  it('saves when the revision matches and returns the next one', async () => {
    const first = await save();

    const second = await save({
      maxAssertionTtlSeconds: 600,
      precondition: { kind: 'revision', revision: revisionOf(first) },
    });

    expect(second.kind).toBe('saved');
    expect(revisionOf(second)).toBe('2');
  });

  it('refuses a stale revision without a write, a cache bump, or an audit event', async () => {
    await save();
    await save({ maxAssertionTtlSeconds: 600 });
    const before = await stored();
    const auditBefore = await auditCount();

    const stale = await save({
      issuer: 'https://other.edu',
      precondition: { kind: 'revision', revision: '1' },
    });

    expect(stale).toEqual({ kind: 'precondition_failed' });
    expect(await stored()).toEqual(before);
    expect(await auditCount()).toBe(auditBefore);
  });

  it('refuses a revision that was based on a state an operator change has passed', async () => {
    const first = await save();
    await pool.query(
      `UPDATE organization_identity_configs
       SET max_assertion_ttl_seconds = 900 WHERE organization_id = $1`,
      [organizationId],
    );

    const stale = await save({
      precondition: { kind: 'revision', revision: revisionOf(first) },
    });

    expect(stale).toEqual({ kind: 'precondition_failed' });
  });

  it('creates only when none exists for a create-only request', async () => {
    const created = await save({ precondition: { kind: 'absent' } });

    expect(created.kind).toBe('saved');
    expect(revisionOf(created)).toBe('1');

    const again = await save({
      issuer: 'https://other.edu',
      precondition: { kind: 'absent' },
    });

    expect(again).toEqual({ kind: 'precondition_failed' });
    expect((await stored()).issuer).toBe('https://acme.edu');
  });

  it('refuses a revision when no configuration exists yet', async () => {
    const result = await save({
      precondition: { kind: 'revision', revision: '1' },
    });

    expect(result).toEqual({ kind: 'precondition_failed' });
  });

  it('answers forbidden before it looks at the precondition', async () => {
    await save();
    const adminId = await seedMember('admin');

    const result = await save({
      userId: adminId,
      precondition: { kind: 'revision', revision: '99' },
    });

    expect(result).toEqual({ kind: 'forbidden' });
  });

  it('keeps the revision when a matching conditional save changes nothing', async () => {
    const first = await save();

    const repeated = await save({
      precondition: { kind: 'revision', revision: revisionOf(first) },
    });

    expect(repeated.kind).toBe('unchanged');
    expect(revisionOf(repeated)).toBe(revisionOf(first));
    expect((await stored()).revision).toBe(revisionOf(first));
  });

  it('holds a disabled configuration to the revision its disabling produced', async () => {
    const first = await save();
    await pool.query(
      `UPDATE organization_identity_configs
       SET status = 'disabled' WHERE organization_id = $1`,
      [organizationId],
    );

    const stale = await save({
      maxAssertionTtlSeconds: 600,
      precondition: { kind: 'revision', revision: revisionOf(first) },
    });
    const current = await save({
      maxAssertionTtlSeconds: 600,
      precondition: { kind: 'revision', revision: '2' },
    });

    expect(stale).toEqual({ kind: 'precondition_failed' });
    expect(current.kind).toBe('saved');
    expect(current).toMatchObject({ config: { status: 'disabled' } });
  });

  it('lets exactly one of two writes from the same revision succeed', async () => {
    const first = await save();
    const precondition: IdentityConfigPrecondition = {
      kind: 'revision',
      revision: revisionOf(first),
    };

    const results = await Promise.all([
      save({ maxAssertionTtlSeconds: 600, precondition }),
      save({ maxAssertionTtlSeconds: 900, precondition }),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      'precondition_failed',
      'saved',
    ]);
    expect((await stored()).revision).toBe('2');
  });

  it('lets exactly one of two first creates succeed', async () => {
    const results = await Promise.all([
      save({ maxAssertionTtlSeconds: 600, precondition: { kind: 'absent' } }),
      save({ maxAssertionTtlSeconds: 900, precondition: { kind: 'absent' } }),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      'precondition_failed',
      'saved',
    ]);
    expect((await stored()).revision).toBe('1');
  });
});

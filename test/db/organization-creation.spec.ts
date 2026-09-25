import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '../../src/common/request-context/request-context.factory';
import type {
  CreateOrganizationRecordInput,
  CreateOrganizationRecordResult,
} from '../../src/modules/identity/application/organization-creation.port';
import { generateApiKey } from '../../src/modules/identity/domain/api-key';
import {
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationApiKeyRepository } from '../../src/modules/identity/infrastructure/postgres-organization-api-key.repository';
import { PostgresOrganizationCreationRepository } from '../../src/modules/identity/infrastructure/postgres-organization-creation.repository';
import { PostgresOrganizationMembershipRepository } from '../../src/modules/identity/infrastructure/postgres-organization-membership.repository';

import {
  createTestPool,
  resetIdentityTables,
  waitForBlockedBy,
} from './database';

const TERMS = {
  entitlements: ['writing', 'speaking'],
  rateLimitRpm: 60,
  maxConcurrent: 5,
  monthlyRequestQuota: 100,
  hardStopOnQuota: true,
} as const;

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOrganizationCreationRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(
    (pool.options as { connectionString?: string }).connectionString ?? '',
  );
  repository = new PostgresOrganizationCreationRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

let creatorId: string;

beforeEach(async () => {
  await resetIdentityTables(pool);
  creatorId = await seedAccount();
});

async function seedAccount(): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`],
  );
  return id;
}

function input(
  overrides: Partial<CreateOrganizationRecordInput> = {},
): CreateOrganizationRecordInput {
  return {
    context: createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: new Date(),
      deadlineMs: 5_000,
      userId: creatorId,
      scopes: [],
    }),
    creatorUserId: creatorId,
    name: 'Acme Learning',
    terms: TERMS,
    creationLimit: 3,
    ...overrides,
  };
}

async function created(
  result: Promise<CreateOrganizationRecordResult>,
): Promise<string> {
  const outcome = await result;
  if (outcome.kind !== 'created') {
    throw new Error(`expected a created Organization, got ${outcome.kind}`);
  }
  return outcome.organizationId;
}

async function counts(): Promise<{
  organizations: number;
  members: number;
  events: number;
}> {
  const result = await pool.query<{
    organizations: number;
    members: number;
    events: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM organizations) AS organizations,
      (SELECT count(*)::int FROM organization_members) AS members,
      (SELECT count(*)::int FROM organization_audit_events) AS events
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('count query returned no row');
  }
  return row;
}

describe('Self-serve Organization creation against PostgreSQL', () => {
  it('creates the Organization on self-serve terms with its creator as the active owner and one audit event', async () => {
    const organizationId = await created(
      repository.createOrganization(input()),
    );

    const organization = await pool.query(
      `SELECT name, status, entitlements, rate_limit_rpm, max_concurrent,
              monthly_request_quota, hard_stop_on_quota,
              created_by_user_account_id
       FROM organizations WHERE id = $1`,
      [organizationId],
    );
    expect(organization.rows).toEqual([
      {
        name: 'Acme Learning',
        status: 'active',
        entitlements: ['writing', 'speaking'],
        identityConfigured: false,
        rate_limit_rpm: 60,
        max_concurrent: 5,
        monthly_request_quota: 100,
        hard_stop_on_quota: true,
        created_by_user_account_id: creatorId,
      },
    ]);

    const membership = await pool.query(
      `SELECT user_account_id, role, status
       FROM organization_members WHERE organization_id = $1`,
      [organizationId],
    );
    expect(membership.rows).toEqual([
      { user_account_id: creatorId, role: 'owner', status: 'active' },
    ]);

    const events = await pool.query(
      `SELECT actor_user_account_id, action, outcome, target_type, target_id,
              target_label
       FROM organization_audit_events WHERE organization_id = $1`,
      [organizationId],
    );
    expect(events.rows).toEqual([
      {
        actor_user_account_id: creatorId,
        action: 'organization.created',
        outcome: 'applied',
        target_type: 'organization',
        target_id: organizationId,
        target_label: 'Acme Learning',
      },
    ]);
  });

  it('leaves no Organization or membership behind when the audit write fails', async () => {
    const failingAudit = new PostgresOrganizationCreationRepository({
      query: (text, values) => client.query(text, values),
      transaction: (callback) =>
        client.transaction((transaction) =>
          callback({
            query: (text, values) =>
              text.includes('INSERT INTO organization_audit_events')
                ? Promise.reject(new Error('audit store unavailable'))
                : transaction.query(text, values),
          }),
        ),
    });

    await expect(failingAudit.createOrganization(input())).rejects.toThrow(
      'Identity store is unavailable',
    );
    await expect(counts()).resolves.toEqual({
      organizations: 0,
      members: 0,
      events: 0,
    });
  });

  it('refuses a creation at the limit without any durable side effect', async () => {
    await created(repository.createOrganization(input({ creationLimit: 1 })));

    await expect(
      repository.createOrganization(input({ creationLimit: 1 })),
    ).resolves.toEqual({ kind: 'limit_reached' });
    await expect(counts()).resolves.toEqual({
      organizations: 1,
      members: 1,
      events: 1,
    });
  });

  it('counts creations rather than holdings and ignores operator-provisioned Organizations', async () => {
    await pool.query(
      "INSERT INTO organizations (id, name) VALUES ('org_operator', 'Operator provisioned')",
    );
    const first = await created(
      repository.createOrganization(input({ creationLimit: 2 })),
    );
    await pool.query(
      "UPDATE organizations SET status = 'suspended' WHERE id = $1",
      [first],
    );
    await created(repository.createOrganization(input({ creationLimit: 2 })));

    await expect(
      repository.createOrganization(input({ creationLimit: 2 })),
    ).resolves.toEqual({ kind: 'limit_reached' });
  });

  it('keeps each account to its own allowance', async () => {
    await created(repository.createOrganization(input({ creationLimit: 1 })));
    const other = await seedAccount();

    await expect(
      repository.createOrganization(
        input({ creatorUserId: other, creationLimit: 1 }),
      ),
    ).resolves.toMatchObject({ kind: 'created' });
  });

  it('serializes concurrent creations on the account so only one takes the last allowance', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM user_accounts WHERE id = $1 FOR UPDATE',
        [creatorId],
      );
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]?.pid;

      const racing = Promise.all([
        repository.createOrganization(input({ creationLimit: 1 })),
        repository.createOrganization(input({ creationLimit: 1 })),
      ]);
      await waitForBlockedBy(pool, holderPid);
      await holder.query('COMMIT');

      const results = await racing;
      expect(results.map((result) => result.kind).sort()).toEqual([
        'created',
        'limit_reached',
      ]);
    } finally {
      holder.release();
    }
    await expect(counts()).resolves.toMatchObject({ organizations: 1 });
  });

  it('refuses an account that is no longer active', async () => {
    await pool.query(
      "UPDATE user_accounts SET status = 'disabled' WHERE id = $1",
      [creatorId],
    );

    await expect(repository.createOrganization(input())).resolves.toEqual({
      kind: 'account_inactive',
    });
    await expect(counts()).resolves.toMatchObject({ organizations: 0 });
  });

  it('shows the new Organization in the roster of its creator, who is its owner', async () => {
    const organizationId = await created(
      repository.createOrganization(input()),
    );

    await expect(
      new PostgresOrganizationMembershipRepository(client).listRoster({
        context: input().context,
        userId: creatorId,
      }),
    ).resolves.toEqual([
      {
        organizationId,
        name: 'Acme Learning',
        status: 'active',
        entitlements: ['writing', 'speaking'],
        membershipRole: 'owner',
        members: [
          {
            username: `user-${creatorId.slice(4, 16).toLowerCase()}`,
            role: 'owner',
          },
        ],
      },
    ]);
  });

  it('gives the creator owner authority to issue a writing key at once', async () => {
    const organizationId = await created(
      repository.createOrganization(input()),
    );
    const context = createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: new Date(),
      deadlineMs: 5_000,
      organizationId,
      userId: creatorId,
      scopes: [],
    });

    await expect(
      new PostgresOrganizationMembershipRepository(client).resolveMembership({
        context,
        organizationId,
        userId: creatorId,
      }),
    ).resolves.toMatchObject({
      kind: 'active',
      membership: { role: 'owner', organizationStatus: 'active' },
    });

    const key = generateApiKey();
    await expect(
      new PostgresOrganizationApiKeyRepository(client).createApiKey({
        context,
        organizationId,
        actorUserId: creatorId,
        apiKeyId: key.id,
        keyHash: key.hash,
        keyPrefix: key.prefix,
        name: 'First key',
        scopes: ['writing.grade'],
        allowedEnvironments: ['production'],
        expiresAt: null,
        requiredEntitlements: ['writing'],
        activeKeyLimit: 50,
      }),
    ).resolves.toMatchObject({ kind: 'created' });
  });
});

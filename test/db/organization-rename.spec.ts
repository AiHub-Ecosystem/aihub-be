import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { RenameOrganizationRecordInput } from '@/modules/identity/application/organization-rename-record.port';
import {
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationMembershipRepository } from '@/modules/identity/infrastructure/postgres-organization-membership.repository';
import { PostgresOrganizationRenameRepository } from '@/modules/identity/infrastructure/postgres-organization-rename.repository';

import {
  createTestPool,
  resetIdentityTables,
  waitForBlockedBy,
} from './database';

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOrganizationRenameRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(
    (pool.options as { connectionString?: string }).connectionString ?? '',
  );
  repository = new PostgresOrganizationRenameRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

let organizationId: string;
let ownerId: string;

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

async function seedMember(
  role: 'owner' | 'admin' | 'member',
  status: 'active' | 'disabled' = 'active',
): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`],
  );
  await pool.query(
    `INSERT INTO organization_members
       (organization_id, user_account_id, role, status)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, id, role, status],
  );
  return id;
}

function input(
  overrides: Partial<RenameOrganizationRecordInput> = {},
): RenameOrganizationRecordInput {
  const userId = overrides.userId ?? ownerId;
  return {
    context: createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: new Date(),
      deadlineMs: 5_000,
      userId,
      scopes: [],
    }),
    userId,
    organizationId,
    name: 'Acme Learning',
    ...overrides,
  };
}

async function organization(): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT name, status, entitlements, rate_limit_rpm, max_concurrent,
            monthly_request_quota, hard_stop_on_quota, updated_at
     FROM organizations WHERE id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('organization row is missing');
  }
  return row;
}

async function events(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, actor_user_account_id, action, outcome, target_type, target_id,
            target_label, detail
     FROM organization_audit_events
     WHERE organization_id = $1
     ORDER BY id`,
    [organizationId],
  );
  return result.rows;
}

describe('Organization rename against PostgreSQL', () => {
  it('renames for an active owner, leaves commercial terms alone, and records the previous name', async () => {
    const before = await organization();

    await expect(repository.renameOrganization(input())).resolves.toEqual({
      kind: 'renamed',
      organizationId,
      name: 'Acme Learning',
    });

    expect(await organization()).toMatchObject({
      name: 'Acme Learning',
      status: 'active',
      entitlements: ['writing'],
      rate_limit_rpm: 60,
      max_concurrent: 5,
      monthly_request_quota: 100,
      hard_stop_on_quota: true,
    });
    expect((await organization()).updated_at).not.toEqual(before.updated_at);
    expect(await events()).toEqual([
      expect.objectContaining({
        actor_user_account_id: ownerId,
        action: 'organization.renamed',
        outcome: 'applied',
        target_type: 'organization',
        target_id: organizationId,
        target_label: 'Acme Learning',
        detail: { previousName: 'Acme' },
      }),
    ]);
  });

  it('shows the new name in the Organization Roster on the next read', async () => {
    await repository.renameOrganization(input());

    const roster = await new PostgresOrganizationMembershipRepository(
      client,
    ).listRoster({ context: input().context, userId: ownerId });

    expect(roster).toEqual([
      expect.objectContaining({ organizationId, name: 'Acme Learning' }),
    ]);
  });

  it('answers a repeat of the current name as unchanged and writes nothing', async () => {
    const before = await organization();

    await expect(
      repository.renameOrganization(input({ name: 'Acme' })),
    ).resolves.toEqual({ kind: 'unchanged', organizationId, name: 'Acme' });

    expect(await organization()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it('treats a change of case as a rename', async () => {
    await expect(
      repository.renameOrganization(input({ name: 'ACME' })),
    ).resolves.toMatchObject({ kind: 'renamed', name: 'ACME' });
    expect(await events()).toHaveLength(1);
  });

  it.each(['admin', 'member'] as const)(
    'refuses an active %s and records the attempt under the current name only',
    async (role) => {
      const callerId = await seedMember(role);

      await expect(
        repository.renameOrganization(
          input({ userId: callerId, name: 'Mine now' }),
        ),
      ).resolves.toEqual({ kind: 'forbidden' });

      expect((await organization()).name).toBe('Acme');
      expect(await events()).toEqual([
        expect.objectContaining({
          actor_user_account_id: callerId,
          action: 'organization.renamed',
          outcome: 'denied',
          target_label: 'Acme',
          detail: { denial: 'insufficient_authority' },
        }),
      ]);
      expect(JSON.stringify(await events())).not.toContain('Mine now');
    },
  );

  it('refuses a disabled owner without recording anything', async () => {
    const disabledOwner = await seedMember('owner', 'disabled');

    await expect(
      repository.renameOrganization(input({ userId: disabledOwner })),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect((await organization()).name).toBe('Acme');
    expect(await events()).toEqual([]);
  });

  it('refuses an account holding no membership without recording anything', async () => {
    const outsider = `usr_${ulid()}`;
    await pool.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [outsider, `user-${outsider.slice(4, 16).toLowerCase()}`],
    );

    await expect(
      repository.renameOrganization(input({ userId: outsider })),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(await events()).toEqual([]);
  });

  it('refuses an unknown Organization', async () => {
    await expect(
      repository.renameOrganization(input({ organizationId: `org_${ulid()}` })),
    ).resolves.toEqual({ kind: 'forbidden' });
  });

  it('refuses every role of a suspended Organization without recording anything', async () => {
    const adminId = await seedMember('admin');
    await pool.query(
      `UPDATE organizations SET status = 'suspended' WHERE id = $1`,
      [organizationId],
    );

    for (const userId of [ownerId, adminId]) {
      await expect(
        repository.renameOrganization(input({ userId })),
      ).resolves.toEqual({ kind: 'forbidden' });
    }
    expect((await organization()).name).toBe('Acme');
    expect(await events()).toEqual([]);
  });

  it('leaves the name unchanged when the audit write fails', async () => {
    const failingAudit = new PostgresOrganizationRenameRepository({
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

    await expect(failingAudit.renameOrganization(input())).rejects.toThrow(
      'Identity store is unavailable',
    );
    expect((await organization()).name).toBe('Acme');
    expect(await events()).toEqual([]);
  });

  it('decides authority after a concurrent demotion commits, not before', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE',
        [organizationId],
      );
      await holder.query(
        `UPDATE organization_members SET role = 'admin'
         WHERE organization_id = $1 AND user_account_id = $2`,
        [organizationId, ownerId],
      );
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]?.pid;

      const racing = repository.renameOrganization(input());
      await waitForBlockedBy(pool, holderPid);
      await holder.query('COMMIT');

      await expect(racing).resolves.toEqual({ kind: 'forbidden' });
    } finally {
      holder.release();
    }

    expect((await organization()).name).toBe('Acme');
    expect(await events()).toEqual([
      expect.objectContaining({ outcome: 'denied' }),
    ]);
  });
});

describe('Audit redaction of a rename', () => {
  async function renamedEventId(): Promise<string> {
    await repository.renameOrganization(input());
    const [event] = await events();
    if (event === undefined || typeof event.id !== 'string') {
      throw new Error('rename event is missing');
    }
    return event.id;
  }

  it('removes the new and the previous name together and leaves the event standing', async () => {
    const id = await renamedEventId();

    await pool.query(
      `UPDATE organization_audit_events
       SET target_label = NULL, detail = detail - 'previousName'
       WHERE id = $1`,
      [id],
    );

    expect(await events()).toEqual([
      expect.objectContaining({
        action: 'organization.renamed',
        target_label: null,
        detail: {},
      }),
    ]);
  });

  it('refuses a redaction that removes the label but keeps the previous name', async () => {
    const id = await renamedEventId();

    await expect(
      pool.query(
        'UPDATE organization_audit_events SET target_label = NULL WHERE id = $1',
        [id],
      ),
    ).rejects.toThrow(/must remove previousName/);
  });

  it('refuses a redaction that keeps the label', async () => {
    const id = await renamedEventId();

    await expect(
      pool.query(
        `UPDATE organization_audit_events
         SET detail = detail - 'previousName'
         WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/only target_label redaction/);
  });

  it('refuses rewriting the previous name', async () => {
    const id = await renamedEventId();

    await expect(
      pool.query(
        `UPDATE organization_audit_events
         SET target_label = NULL,
             detail = '{"previousName": "Someone else"}'::jsonb
         WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/must remove previousName/);
  });

  it('refuses removing any other detail key of a rename', async () => {
    const id = await renamedEventId();

    await expect(
      pool.query(
        `UPDATE organization_audit_events
         SET target_label = NULL,
             detail = detail - 'previousName' || '{"extra": true}'::jsonb
         WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/must remove previousName/);
  });

  it("keeps every other action's detail immutable", async () => {
    const callerId = await seedMember('member');
    await repository.renameOrganization(input({ userId: callerId }));
    const [denied] = await events();

    await expect(
      pool.query(
        `UPDATE organization_audit_events
         SET target_label = NULL, detail = '{}'::jsonb
         WHERE id = $1`,
        [denied?.id],
      ),
    ).rejects.toThrow(/only target_label redaction/);

    await pool.query(
      `INSERT INTO organization_audit_events
         (id, organization_id, actor_user_account_id, action, outcome,
          target_type, target_id, target_label, detail, request_id, occurred_at)
       VALUES ($1, $2, $3, 'organization.created', 'applied', 'organization',
               $2, 'Acme', '{"previousName": "x"}'::jsonb, $4, now())`,
      [`oae_${ulid()}`, organizationId, ownerId, `req_${ulid()}`],
    );
    await expect(
      pool.query(
        `UPDATE organization_audit_events
         SET target_label = NULL, detail = detail - 'previousName'
         WHERE action = 'organization.created'`,
      ),
    ).rejects.toThrow(/only target_label redaction/);
  });
});

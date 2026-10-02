import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import { generateOrganizationApiKey } from '@/modules/identity/application/organization-api-key-generator';
import type { AttachFirstOwnerInput } from '@/modules/identity/application/organization-first-owner.port';
import {
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationApiKeyRepository } from '@/modules/identity/infrastructure/postgres-organization-api-key.repository';
import { PostgresOrganizationFirstOwnerRepository } from '@/modules/identity/infrastructure/postgres-organization-first-owner.repository';
import { PostgresOrganizationInvitationRepository } from '@/modules/identity/infrastructure/postgres-organization-invitation.repository';
import { PostgresOrganizationMembershipRepository } from '@/modules/identity/infrastructure/postgres-organization-membership.repository';

import {
  createTestPool,
  resetIdentityTables,
  waitForBlockedBy,
} from './database';

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOrganizationFirstOwnerRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(
    (pool.options as { connectionString?: string }).connectionString ?? '',
  );
  repository = new PostgresOrganizationFirstOwnerRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

let organizationId: string;
let ownerId: string;
let operatorId: string;

async function seedAccount(
  username: string,
  status: 'active' | 'pending_verification' | 'disabled' = 'active',
): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [id, username, status],
  );
  return id;
}

async function seedMembership(
  userId: string,
  role: 'owner' | 'admin' | 'member',
  status: 'active' | 'disabled',
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members
       (organization_id, user_account_id, role, status)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, userId, role, status],
  );
}

beforeEach(async () => {
  await resetIdentityTables(pool);
  organizationId = `org_${ulid()}`;
  // Operator-provisioned: no creator, no members.
  await pool.query(
    `INSERT INTO organizations (id, name, entitlements)
     VALUES ($1, 'Acme', ARRAY['writing'])`,
    [organizationId],
  );
  ownerId = await seedAccount('acme-owner');
  operatorId = await seedAccount('aihub-ops-alice');
});

function input(
  overrides: Partial<AttachFirstOwnerInput> = {},
): AttachFirstOwnerInput {
  return {
    organizationId,
    ownerUsername: 'acme-owner',
    actorUsername: 'aihub-ops-alice',
    requestId: `req_${ulid()}`,
    occurredAt: new Date(),
    ...overrides,
  };
}

async function memberships(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT user_account_id, role, status
     FROM organization_members
     WHERE organization_id = $1
     ORDER BY user_account_id`,
    [organizationId],
  );
  return result.rows;
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

describe('First Owner Attachment against PostgreSQL', () => {
  it('makes the account the active owner and records the operator as actor', async () => {
    const requestId = `req_${ulid()}`;

    await expect(
      repository.attachFirstOwner(input({ requestId })),
    ).resolves.toEqual({ kind: 'attached' });

    expect(await memberships()).toEqual([
      { user_account_id: ownerId, role: 'owner', status: 'active' },
    ]);
    expect(await events()).toEqual([
      {
        actor_user_account_id: operatorId,
        action: 'membership.owner_attached',
        outcome: 'applied',
        target_type: 'membership',
        target_id: ownerId,
        target_label: 'acme-owner',
        detail: { role: 'owner' },
        request_id: requestId,
      },
    ]);
  });

  it('answers a repeat for the sole owner as unchanged and records nothing more', async () => {
    await repository.attachFirstOwner(input());

    await expect(repository.attachFirstOwner(input())).resolves.toEqual({
      kind: 'unchanged',
    });
    expect(await events()).toHaveLength(1);
  });

  it('refuses once the Organization has an active member, even another owner candidate', async () => {
    await repository.attachFirstOwner(input());
    await seedAccount('someone-else');

    await expect(
      repository.attachFirstOwner(input({ ownerUsername: 'someone-else' })),
    ).resolves.toEqual({ kind: 'organization_has_members' });
    expect(await memberships()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('refuses an Organization whose only active member is not the named account', async () => {
    const memberId = await seedAccount('acme-member');
    await seedMembership(memberId, 'member', 'active');

    await expect(repository.attachFirstOwner(input())).resolves.toEqual({
      kind: 'organization_has_members',
    });
    expect(await events()).toEqual([]);
  });

  it('reactivates a disabled membership of the named account as owner', async () => {
    await seedMembership(ownerId, 'member', 'disabled');

    await expect(repository.attachFirstOwner(input())).resolves.toEqual({
      kind: 'attached',
    });
    expect(await memberships()).toEqual([
      { user_account_id: ownerId, role: 'owner', status: 'active' },
    ]);
  });

  it('attaches an owner whose email is not verified yet', async () => {
    const pendingId = await seedAccount(
      'pending-owner',
      'pending_verification',
    );

    await expect(
      repository.attachFirstOwner(input({ ownerUsername: 'pending-owner' })),
    ).resolves.toEqual({ kind: 'attached' });
    expect(await memberships()).toEqual([
      { user_account_id: pendingId, role: 'owner', status: 'active' },
    ]);
  });

  it('refuses an operator whose own account is not verified', async () => {
    await seedAccount('pending-operator', 'pending_verification');

    await expect(
      repository.attachFirstOwner(input({ actorUsername: 'pending-operator' })),
    ).resolves.toEqual({ kind: 'actor_invalid' });
  });

  it('attaches an owner to a suspended Organization', async () => {
    await pool.query(
      `UPDATE organizations SET status = 'suspended' WHERE id = $1`,
      [organizationId],
    );

    await expect(repository.attachFirstOwner(input())).resolves.toEqual({
      kind: 'attached',
    });
  });

  it.each([
    [
      'an unknown Organization',
      () => ({ organizationId: `org_${ulid()}` }),
      'organization_not_found',
    ],
    ['an unknown owner', () => ({ ownerUsername: 'nobody' }), 'owner_invalid'],
    [
      'a disabled owner',
      () => ({ ownerUsername: 'disabled-user' }),
      'owner_invalid',
    ],
    ['an unknown actor', () => ({ actorUsername: 'nobody' }), 'actor_invalid'],
    [
      'a disabled actor',
      () => ({ actorUsername: 'disabled-user' }),
      'actor_invalid',
    ],
    [
      'an operator naming themselves',
      () => ({ ownerUsername: 'aihub-ops-alice' }),
      'actor_is_owner',
    ],
  ] as const)(
    'refuses %s without writing anything',
    async (_, overrides, kind) => {
      await seedAccount('disabled-user', 'disabled');

      await expect(
        repository.attachFirstOwner(input(overrides())),
      ).resolves.toEqual({ kind });
      expect(await memberships()).toEqual([]);
      expect(
        (await pool.query('SELECT 1 FROM organization_audit_events')).rowCount,
      ).toBe(0);
    },
  );

  it('leaves exactly one owner when two attachments race', async () => {
    await seedAccount('rival-owner');
    // Hold the Organization lock so both attachments are provably in flight
    // together; without it they could run one after the other and pass with
    // no lock at all.
    const holder = await pool.connect();
    let results: { kind: string }[];
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE',
        [organizationId],
      );
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]?.pid;

      const racing = Promise.all([
        repository.attachFirstOwner(input()),
        repository.attachFirstOwner(input({ ownerUsername: 'rival-owner' })),
      ]);
      await waitForBlockedBy(pool, holderPid);
      await holder.query('COMMIT');
      results = await racing;
    } finally {
      holder.release();
    }

    expect(results.map((result) => result.kind).sort()).toEqual([
      'attached',
      'organization_has_members',
    ]);
    expect(await memberships()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('lets the attached owner create an API key and invite a member with no further SQL', async () => {
    await repository.attachFirstOwner(input());
    const context = createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: new Date(),
      deadlineMs: 5_000,
      organizationId,
      userId: ownerId,
      scopes: [],
    });

    await expect(
      new PostgresOrganizationMembershipRepository(client).resolveMembership({
        context,
        organizationId,
        userId: ownerId,
      }),
    ).resolves.toMatchObject({
      kind: 'active',
      membership: { role: 'owner', organizationStatus: 'active' },
    });

    const key = generateOrganizationApiKey();
    await expect(
      new PostgresOrganizationApiKeyRepository(client).createApiKey({
        context,
        organizationId,
        actorUserId: ownerId,
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

    const now = new Date();
    await expect(
      new PostgresOrganizationInvitationRepository(client).createInvitation({
        context,
        invitationId: `oiv_${ulid()}`,
        organizationId,
        email: 'teammate@example.com',
        role: 'member',
        invitedBy: ownerId,
        tokenHash: createHash('sha256').update('token').digest('hex'),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        now,
      }),
    ).resolves.toMatchObject({ kind: 'created' });
  });
});

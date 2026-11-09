import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import type {
  CreateOrganizationApiKeyRecordResult,
  RevokeOrganizationApiKeyRecordResult,
  RotateOrganizationApiKeyRecordResult,
} from '@/modules/identity/api-keys/application/organization-api-key.port';
import { PostgresOrganizationApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-organization-api-key.repository';
import type { CreateOrganizationInvitationResult } from '@/modules/identity/invitations/application/organization-invitation.port';
import { PostgresOrganizationInvitationAcceptRepository } from '@/modules/identity/invitations/infrastructure/postgres-organization-invitation-accept.repository';
import { PostgresOrganizationInvitationCreateRepository } from '@/modules/identity/invitations/infrastructure/postgres-organization-invitation-create.repository';
import { PostgresOrganizationInvitationRevokeRepository } from '@/modules/identity/invitations/infrastructure/postgres-organization-invitation-revoke.repository';
import type { OrganizationMembershipRole } from '@/modules/identity/membership/application/organization-membership.port';
import {
  type IdentityFixtureClient,
  createPostgresIdentityClient,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

import { pauseAtStatement } from '../auth/pause-before-commit';
import { type PostgresAuthClient } from '../auth/postgres-auth.client';
import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
  waitForBlockedBy,
} from '../shared/database';

/**
 * ADR-0159 (ADR-0027 as amended, #447): a member's authority ends everywhere
 * when it is removed. These are the gate-based PostgreSQL regressions for the
 * serialization boundary: two connections, explicit barriers, no timing
 * sleeps. The authority change is one raw connection that holds the
 * Organization row and the member row open; the mutation under test is a real
 * repository transaction on a second connection that must queue behind it and
 * then refuse — or, for the role-preserving controls, proceed.
 */
const ORGANIZATION_ID = 'org_acme';
const INVITED_EMAIL = 'invitee@example.com';
const NOW = new Date('2026-09-21T12:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-22T12:00:00.000Z');

let pool: Pool;
let mutations: IdentityFixtureClient;
let acceptances: PostgresOrganizationInvitationAcceptRepository;

beforeAll(() => {
  pool = createTestPool();
  mutations = createPostgresIdentityClient(testDatabaseUrl());
  acceptances = new PostgresOrganizationInvitationAcceptRepository(mutations);
});

afterAll(async () => {
  await mutations.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

type MembershipStatus = 'active' | 'disabled';

function userId(): string {
  return `usr_${ulid()}`;
}

function tokenHash(): string {
  return createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
}

async function seedOrganization(): Promise<void> {
  await pool.query(
    'INSERT INTO organizations (id, name, status, entitlements) VALUES ($1, $2, $3, $4)',
    [ORGANIZATION_ID, `Organization ${ORGANIZATION_ID}`, 'active', ['writing']],
  );
}

async function seedAccount(email: string): Promise<string> {
  const id = userId();
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`, NOW],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
    [`auth_${ulid()}`, id, email, ARGON2ID_DUMMY_HASH, NOW],
  );
  return id;
}

async function seedMembership(
  userAccountId: string,
  role: OrganizationMembershipRole,
  status: MembershipStatus = 'active',
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [ORGANIZATION_ID, userAccountId, role, status, NOW],
  );
}

function managementContext(actorId: string) {
  return createRequestContext({
    requestId: `req_${ulid()}`,
    receivedAt: NOW,
    deadlineMs: 5_000,
    organizationId: ORGANIZATION_ID,
    userId: actorId,
    scopes: [],
  });
}

/**
 * The authority change, held open. It takes the locks the real disable and
 * demotion transactions take — the Organization row first, then the member
 * row (ADR-0043, ADR-0159) — and reports its backend pid so the mutation's
 * wait can be observed with `waitForBlockedBy` instead of a sleep.
 */
async function holdAuthorityChange(options: {
  readonly memberId: string;
  readonly role?: OrganizationMembershipRole;
  readonly status?: MembershipStatus;
}): Promise<{
  readonly pid: number;
  readonly commit: () => Promise<void>;
}> {
  const connection = await pool.connect();
  await connection.query('BEGIN');
  await connection.query(
    'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
    [ORGANIZATION_ID],
  );
  await connection.query(
    `UPDATE organization_members
     SET role = COALESCE($3, role), status = COALESCE($4, status), updated_at = now()
     WHERE organization_id = $1 AND user_account_id = $2`,
    [
      ORGANIZATION_ID,
      options.memberId,
      options.role ?? null,
      options.status ?? null,
    ],
  );
  const pid = (
    await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  ).rows[0]!.pid;
  return {
    pid,
    commit: async () => {
      await connection.query('COMMIT');
      connection.release();
    },
  };
}

/** Starts `mutation`, waits until it is queued behind `pid`, then commits. */
async function raceBehindAuthorityChange<Next>(
  holder: { readonly pid: number; readonly commit: () => Promise<void> },
  mutation: () => Promise<Next>,
): Promise<Next> {
  const pending = mutation();
  try {
    await waitForBlockedBy(pool, holder.pid);
  } finally {
    await holder.commit();
  }
  return pending;
}

function recordingOutbox() {
  const queued: string[] = [];
  const port: EmailOutboxPort = {
    withAdmission: async (_kind, operation) => operation(),
    reserveAuthenticationEmailRecipient: async () => true,
    queue: async (_transaction, input) => {
      queued.push(input.kind);
    },
    withdraw: async () => undefined,
  };
  return { queued, port };
}

async function seedKeyRow(): Promise<string> {
  const generated = generateOrganizationApiKey(NOW);
  await pool.query(
    `INSERT INTO api_keys
       (id, organization_id, key_hash, key_prefix, name, scopes,
        allowed_environments, status, created_at)
     VALUES ($1, $2, decode($3, 'hex'), $4, 'Prod backend', $5, $6,
             'active', $7)`,
    [
      generated.id,
      ORGANIZATION_ID,
      generated.hash,
      generated.prefix,
      ['writing.grade'],
      ['production'],
      NOW,
    ],
  );
  return generated.id;
}

function createMutation(
  repository: PostgresOrganizationApiKeyRepository,
  caller: string,
): Promise<CreateOrganizationApiKeyRecordResult> {
  const replacement = generateOrganizationApiKey(NOW);
  return repository.createApiKey({
    context: managementContext(caller),
    organizationId: ORGANIZATION_ID,
    actorUserId: caller,
    apiKeyId: replacement.id,
    keyHash: replacement.hash,
    keyPrefix: replacement.prefix,
    name: 'Prod backend',
    scopes: ['writing.grade'],
    allowedEnvironments: ['production'],
    expiresAt: null,
    requiredEntitlements: ['writing'],
    activeKeyLimit: 50,
  });
}

function rotateMutation(
  repository: PostgresOrganizationApiKeyRepository,
  caller: string,
  apiKeyId: string,
): Promise<RotateOrganizationApiKeyRecordResult> {
  const replacement = generateOrganizationApiKey(NOW);
  return repository.rotateApiKey({
    context: managementContext(caller),
    organizationId: ORGANIZATION_ID,
    actorUserId: caller,
    apiKeyId,
    replacementId: replacement.id,
    keyHash: replacement.hash,
    keyPrefix: replacement.prefix,
    retiredAllowedEnvironments: ['production'],
    replacementAllowedEnvironments: ['production'],
    rotatedByUsername: 'rotator',
    now: NOW,
  });
}

function revokeMutation(
  repository: PostgresOrganizationApiKeyRepository,
  caller: string,
  apiKeyId: string,
): Promise<RevokeOrganizationApiKeyRecordResult> {
  return repository.revokeApiKey({
    context: managementContext(caller),
    organizationId: ORGANIZATION_ID,
    actorUserId: caller,
    apiKeyId,
    now: NOW,
  });
}

async function keyRows(): Promise<readonly { id: string; status: string }[]> {
  const result = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM api_keys WHERE organization_id = $1 ORDER BY id',
    [ORGANIZATION_ID],
  );
  return result.rows;
}

describe('API key mutations refuse an authority that ended before their locks (ADR-0159)', () => {
  let caller: string;
  let repository: PostgresOrganizationApiKeyRepository;

  beforeEach(async () => {
    await seedOrganization();
    caller = await seedAccount('caller@example.com');
    await seedMembership(caller, 'owner');
    repository = new PostgresOrganizationApiKeyRepository(mutations);
  });

  it('refuses a create that queued behind a committed demotion to member', async () => {
    const holder = await holdAuthorityChange({
      memberId: caller,
      role: 'member',
    });

    const outcome = await raceBehindAuthorityChange(holder, () =>
      createMutation(repository, caller),
    );

    expect(outcome).toEqual({ kind: 'caller_not_authorized' });
    expect(await keyRows()).toEqual([]);
  });

  it('refuses a rotate that queued behind a committed demotion to member', async () => {
    const apiKeyId = await seedKeyRow();
    const holder = await holdAuthorityChange({
      memberId: caller,
      role: 'member',
    });

    const outcome = await raceBehindAuthorityChange(holder, () =>
      rotateMutation(repository, caller, apiKeyId),
    );

    expect(outcome).toEqual({ kind: 'caller_not_authorized' });
    expect(await keyRows()).toEqual([{ id: apiKeyId, status: 'active' }]);
  });

  it('refuses a revoke that queued behind a committed demotion to member', async () => {
    const apiKeyId = await seedKeyRow();
    const holder = await holdAuthorityChange({
      memberId: caller,
      role: 'member',
    });

    const outcome = await raceBehindAuthorityChange(holder, () =>
      revokeMutation(repository, caller, apiKeyId),
    );

    expect(outcome).toEqual({ kind: 'caller_not_authorized' });
    expect(await keyRows()).toEqual([{ id: apiKeyId, status: 'active' }]);
  });

  it('still admits a create after a role-preserving transfer to active admin', async () => {
    // The positive control: the transfer is committed first, and an active
    // admin keeps API-key management authority (ADR-0159, decision 2).
    await pool.query(
      `UPDATE organization_members SET role = 'admin', updated_at = now()
       WHERE organization_id = $1 AND user_account_id = $2`,
      [ORGANIZATION_ID, caller],
    );

    await expect(createMutation(repository, caller)).resolves.toMatchObject({
      kind: 'created',
    });
  });

  it('still admits a rotate after a role-preserving transfer to active admin', async () => {
    await pool.query(
      `UPDATE organization_members SET role = 'admin', updated_at = now()
       WHERE organization_id = $1 AND user_account_id = $2`,
      [ORGANIZATION_ID, caller],
    );
    const apiKeyId = await seedKeyRow();

    await expect(
      rotateMutation(repository, caller, apiKeyId),
    ).resolves.toMatchObject({ kind: 'rotated' });
  });

  it('still admits a revoke after a role-preserving transfer to active admin', async () => {
    await pool.query(
      `UPDATE organization_members SET role = 'admin', updated_at = now()
       WHERE organization_id = $1 AND user_account_id = $2`,
      [ORGANIZATION_ID, caller],
    );
    const apiKeyId = await seedKeyRow();

    await expect(
      revokeMutation(repository, caller, apiKeyId),
    ).resolves.toMatchObject({ kind: 'revoked' });
  });
});

describe('Invitation send and revoke re-read the caller under the Organization lock (ADR-0159)', () => {
  let inviter: string;
  let creations: PostgresOrganizationInvitationCreateRepository;
  let revocations: PostgresOrganizationInvitationRevokeRepository;
  let outbox: ReturnType<typeof recordingOutbox>;

  beforeEach(async () => {
    await seedOrganization();
    inviter = await seedAccount('inviter@example.com');
    await seedMembership(inviter, 'owner');
    outbox = recordingOutbox();
    creations = new PostgresOrganizationInvitationCreateRepository(
      mutations,
      outbox.port,
    );
    revocations = new PostgresOrganizationInvitationRevokeRepository(mutations);
  });

  it('refuses a send that queued behind a committed demotion to member', async () => {
    const holder = await holdAuthorityChange({
      memberId: inviter,
      role: 'member',
    });

    const outcome = await raceBehindAuthorityChange(
      holder,
      () =>
        creations.createInvitation({
          context: managementContext(inviter),
          invitationId: `oiv_${ulid()}`,
          organizationId: ORGANIZATION_ID,
          email: INVITED_EMAIL,
          role: 'member',
          invitedBy: inviter,
          tokenHash: tokenHash(),
          expiresAt: EXPIRES_AT,
          emailDelivery: { token: 'raw-invite-token', createdAt: NOW },
          now: NOW,
        }) as Promise<CreateOrganizationInvitationResult>,
    );

    expect(outcome).toEqual({ kind: 'caller_not_authorized' });
    const invitations = await pool.query(
      'SELECT id FROM organization_invitations WHERE organization_id = $1',
      [ORGANIZATION_ID],
    );
    expect(invitations.rows).toEqual([]);
    expect(outbox.queued).toEqual([]);
  });

  it('still admits a member invitation from an inviter now an active admin', async () => {
    await pool.query(
      `UPDATE organization_members SET role = 'admin', updated_at = now()
       WHERE organization_id = $1 AND user_account_id = $2`,
      [ORGANIZATION_ID, inviter],
    );

    await expect(
      creations.createInvitation({
        context: managementContext(inviter),
        invitationId: `oiv_${ulid()}`,
        organizationId: ORGANIZATION_ID,
        email: INVITED_EMAIL,
        role: 'member',
        invitedBy: inviter,
        tokenHash: tokenHash(),
        expiresAt: EXPIRES_AT,
        emailDelivery: { token: 'raw-invite-token', createdAt: NOW },
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: 'created' });
    expect(outbox.queued).toHaveLength(1);
  });

  it('refuses a revoke that queued behind a committed demotion to member', async () => {
    const invitationId = `oiv_${ulid()}`;
    const hash = tokenHash();
    await pool.query(
      `INSERT INTO organization_invitations (
         id, organization_id, email, role, invited_by, token_hash,
         expires_at, created_at
       ) VALUES ($1, $2, $3, 'owner', $4, $5, $6, $7)`,
      [
        invitationId,
        ORGANIZATION_ID,
        INVITED_EMAIL,
        inviter,
        hash,
        EXPIRES_AT,
        NOW,
      ],
    );

    const holder = await holdAuthorityChange({
      memberId: inviter,
      role: 'member',
    });

    const pending = raceBehindAuthorityChange(holder, () =>
      revocations.revokeInvitation({
        context: managementContext(inviter),
        actorUserId: inviter,
        organizationId: ORGANIZATION_ID,
        invitationId,
        now: NOW,
      }),
    );

    await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const open = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM organization_invitations WHERE id = $1',
      [invitationId],
    );
    expect(open.rows[0]?.consumed_at).toBeNull();
  });
});

describe('Acceptance admission against the inviter current authority (ADR-0159)', () => {
  let inviter: string;
  let recipient: string;
  let invitationId: string;
  let hash: string;

  beforeEach(async () => {
    await seedOrganization();
    inviter = await seedAccount('inviter@example.com');
    recipient = await seedAccount(INVITED_EMAIL);
    await seedMembership(inviter, 'owner');
    invitationId = `oiv_${ulid()}`;
    hash = tokenHash();
    await pool.query(
      `INSERT INTO organization_invitations (
         id, organization_id, email, role, invited_by, token_hash,
         expires_at, created_at
       ) VALUES ($1, $2, $3, 'owner', $4, $5, $6, $7)`,
      [
        invitationId,
        ORGANIZATION_ID,
        INVITED_EMAIL,
        inviter,
        hash,
        EXPIRES_AT,
        NOW,
      ],
    );
  });

  async function membershipRole(userAccountId: string): Promise<string | null> {
    const rows = await pool.query<{ role: string }>(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_account_id = $2',
      [ORGANIZATION_ID, userAccountId],
    );
    return rows.rows[0]?.role ?? null;
  }

  it('refuses when the inviter demotion commits after the status read but before the inviter read', async () => {
    // The gate: acceptance is paused right before it reads the inviter's
    // Membership, the demotion commits in that window, and the read then sees
    // the committed demotion. The grant never happens and the token survives.
    const gated = pauseAtStatement(
      mutations as unknown as PostgresAuthClient,
      (statement) =>
        statement.kind === 'raw' &&
        statement.text.includes('FROM organization_members') &&
        statement.text.includes('user_account_id = $2'),
    );
    const acceptance = new PostgresOrganizationInvitationAcceptRepository(
      gated.client,
    );

    const pending = acceptance.acceptInvitation({
      context: createRequestContext({
        requestId: `req_${ulid()}`,
        receivedAt: NOW,
        deadlineMs: 5_000,
        userId: recipient,
        scopes: [],
      }),
      userId: recipient,
      tokenHash: hash,
      now: NOW,
    });
    await gated.reached;

    await pool.query(
      `UPDATE organization_members SET role = 'member', updated_at = now()
       WHERE organization_id = $1 AND user_account_id = $2`,
      [ORGANIZATION_ID, inviter],
    );

    gated.resume();
    await expect(pending).resolves.toEqual({ kind: 'inviter_unauthorized' });

    expect(await membershipRole(recipient)).toBeNull();
    const open = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM organization_invitations WHERE id = $1',
      [invitationId],
    );
    expect(open.rows[0]?.consumed_at).toBeNull();
  });

  it('serializes its grant behind a membership change that holds the Organization mutex first', async () => {
    // The recipient's own membership row is the grant's target: the disable
    // takes the Organization row and then that row, acceptance queues behind
    // it at the upsert, and the reactivation the invitation carries is what
    // commits. No timing sleeps: the wait is observed through pg_blocking_pids.
    const holder = await holdAuthorityChange({
      memberId: recipient,
      status: 'disabled',
    });

    const pending = acceptances.acceptInvitation({
      context: createRequestContext({
        requestId: `req_${ulid()}`,
        receivedAt: NOW,
        deadlineMs: 5_000,
        userId: recipient,
        scopes: [],
      }),
      userId: recipient,
      tokenHash: hash,
      now: NOW,
    });
    await waitForBlockedBy(pool, holder.pid);
    await holder.commit();

    await expect(pending).resolves.toMatchObject({
      kind: 'accepted',
      role: 'owner',
    });
    expect(await membershipRole(recipient)).toBe('owner');
  });

  it('lets an acceptance that serialized its grant first stand after a later demotion', async () => {
    // A transaction that serialized before the authority change may finish:
    // the grant commits, the inviter is demoted afterwards, and the
    // membership the grant created is not undone.
    await expect(
      acceptances.acceptInvitation({
        context: createRequestContext({
          requestId: `req_${ulid()}`,
          receivedAt: NOW,
          deadlineMs: 5_000,
          userId: recipient,
          scopes: [],
        }),
        userId: recipient,
        tokenHash: hash,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: 'accepted', role: 'owner' });

    await pool.query(
      `UPDATE organization_members SET role = 'member', updated_at = now()
       WHERE organization_id = $1 AND user_account_id = $2`,
      [ORGANIZATION_ID, inviter],
    );

    expect(await membershipRole(recipient)).toBe('owner');
  });

  it('runs a demotion and an acceptance concurrently without a lock-order inversion', async () => {
    // Both operations share one lock order: Organization row first, then
    // membership/invitation rows (ADR-0159, decision 6). Acceptance takes
    // the Organization row FOR SHARE before it reads or grants; a concurrent
    // demotion attempts Organization FOR UPDATE and serializes behind it.
    // Both commit cleanly without deadlock.
    const gated = pauseAtStatement(
      mutations as unknown as PostgresAuthClient,
      (statement) =>
        statement.kind === 'raw' &&
        statement.text.includes('FROM organization_invitations') &&
        statement.text.includes('FOR UPDATE'),
    );
    const acceptance = new PostgresOrganizationInvitationAcceptRepository(
      gated.client,
    );

    const pending = acceptance.acceptInvitation({
      context: createRequestContext({
        requestId: `req_${ulid()}`,
        receivedAt: NOW,
        deadlineMs: 5_000,
        userId: recipient,
        scopes: [],
      }),
      userId: recipient,
      tokenHash: hash,
      now: NOW,
    });
    await gated.reached;

    const demoteConn = await pool.connect();
    await demoteConn.query('BEGIN');
    const demoteQuery = demoteConn.query(
      'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
      [ORGANIZATION_ID],
    );

    // Acceptance holds FOR SHARE; demote queues behind it for FOR UPDATE.
    // Acceptance resumes, grants owner, and commits.
    gated.resume();
    await expect(pending).resolves.toMatchObject({
      kind: 'accepted',
      role: 'owner',
    });

    // Now demote acquires the lock and finishes cleanly.
    await demoteQuery;
    await demoteConn.query(
      `UPDATE organization_members SET role = 'member', updated_at = now()
       WHERE organization_id = $1 AND user_account_id = $2`,
      [ORGANIZATION_ID, inviter],
    );
    await demoteConn.query('COMMIT');
    demoteConn.release();

    expect(await membershipRole(recipient)).toBe('owner');
    expect(await membershipRole(inviter)).toBe('member');
  });
});

import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '../../src/common/request-context/request-context.factory';
import type {
  AcceptOrganizationInvitationResult,
  CreateOrganizationInvitationResult,
} from '../../src/modules/identity/application/organization-invitation.port';
import type { OrganizationMembershipRole } from '../../src/modules/identity/application/organization-membership.port';
import type { PostgresIdentityTransactionalClient } from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { createPostgresIdentityClient } from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationInvitationRepository } from '../../src/modules/identity/infrastructure/postgres-organization-invitation.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
  waitForBlockedBy,
} from './database';

const ORGANIZATION_ID = 'org_acme';
const OTHER_ORGANIZATION_ID = 'org_other';
const INVITED_EMAIL = 'invitee@example.com';
const NOW = new Date('2026-09-21T12:00:00.000Z');

const EXPIRES_AT = new Date('2026-09-22T12:00:00.000Z');

type AccountStatus = 'pending_verification' | 'active' | 'disabled';
type MembershipStatus = 'active' | 'disabled';

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOrganizationInvitationRepository;

function userId(): string {
  return `usr_${ulid()}`;
}

function invitationId(): string {
  return `oiv_${ulid()}`;
}

function tokenHash(): string {
  return createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
}

async function seedOrganization(
  id: string,
  status: 'active' | 'suspended' = 'active',
): Promise<void> {
  await pool.query(
    'INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)',
    [id, `Organization ${id}`, status],
  );
}

async function seedAccount(options: {
  readonly email: string;
  readonly status?: AccountStatus;
  readonly withIdentity?: boolean;
}): Promise<string> {
  const id = userId();
  const { email, status = 'active', withIdentity = true } = options;

  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`, status, NOW],
  );

  if (withIdentity) {
    await pool.query(
      `INSERT INTO auth_identities (
         id, user_account_id, provider, canonical_email, password_hash,
         created_at, updated_at
       ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
      [
        `auth_${ulid()}`,
        id,
        email,
        '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaA',
        NOW,
      ],
    );
  }

  return id;
}

async function seedMembership(options: {
  readonly organizationId: string;
  readonly userAccountId: string;
  readonly role: OrganizationMembershipRole;
  readonly status: MembershipStatus;
}): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [
      options.organizationId,
      options.userAccountId,
      options.role,
      options.status,
      NOW,
    ],
  );
}

function acceptContext(accepterId: string) {
  return createRequestContext({
    requestId: `req_${ulid()}`,
    receivedAt: NOW,
    deadlineMs: 5_000,
    userId: accepterId,
    scopes: [],
  });
}

async function invite(options: {
  readonly inviterId: string;
  readonly email?: string;
  readonly role?: OrganizationMembershipRole;
  readonly tokenHash?: string;
  readonly organizationId?: string;
  readonly invitationId?: string;
}): Promise<CreateOrganizationInvitationResult> {
  const organizationId = options.organizationId ?? ORGANIZATION_ID;
  return repository.createInvitation({
    context: createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: NOW,
      deadlineMs: 5_000,
      organizationId,
      userId: options.inviterId,
      scopes: [],
    }),
    invitationId: options.invitationId ?? invitationId(),
    organizationId,
    email: options.email ?? INVITED_EMAIL,
    role: options.role ?? 'member',
    invitedBy: options.inviterId,
    tokenHash: options.tokenHash ?? tokenHash(),
    expiresAt: EXPIRES_AT,
    now: NOW,
  });
}

async function accept(options: {
  readonly accepterId: string;
  readonly tokenHash: string;
  readonly now?: Date;
}): Promise<AcceptOrganizationInvitationResult> {
  return repository.acceptInvitation({
    context: acceptContext(options.accepterId),
    userId: options.accepterId,
    tokenHash: options.tokenHash,
    now: options.now ?? NOW,
  });
}

async function insertInvitationRow(row: {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: string;
  readonly invitedBy: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO organization_invitations (
       id, organization_id, email, role, invited_by, token_hash,
       expires_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.id,
      row.organizationId,
      row.email,
      row.role,
      row.invitedBy,
      row.tokenHash,
      row.expiresAt,
      row.createdAt,
    ],
  );
}

async function openInvitations(organizationId = ORGANIZATION_ID) {
  const result = await pool.query(
    `SELECT id, email, role, token_hash
     FROM organization_invitations
     WHERE organization_id = $1 AND consumed_at IS NULL
     ORDER BY created_at`,
    [organizationId],
  );
  return result.rows;
}

async function membershipRow(organizationId: string, userAccountId: string) {
  const result = await pool.query(
    `SELECT role, status FROM organization_members
     WHERE organization_id = $1 AND user_account_id = $2`,
    [organizationId, userAccountId],
  );
  return result.rows[0];
}

async function seedInviterOwner(): Promise<string> {
  const inviterId = await seedAccount({ email: 'owner@example.com' });
  await seedMembership({
    organizationId: ORGANIZATION_ID,
    userAccountId: inviterId,
    role: 'owner',
    status: 'active',
  });
  return inviterId;
}

async function invitationByHash(tokenHash: string) {
  const result = await pool.query(
    'SELECT consumed_at FROM organization_invitations WHERE token_hash = $1',
    [tokenHash],
  );
  return result.rows[0];
}

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(testDatabaseUrl());
  repository = new PostgresOrganizationInvitationRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  await seedOrganization(ORGANIZATION_ID);
});

describe('organization invitation against PostgreSQL', () => {
  let inviterId: string;

  beforeEach(async () => {
    inviterId = await seedInviterOwner();
  });

  it('invites an email with no AIHUB User Account', async () => {
    const result = await invite({ inviterId });

    expect(result.kind).toBe('created');
    expect(await openInvitations()).toHaveLength(1);
  });

  it('invites an account that holds no membership', async () => {
    await seedAccount({ email: INVITED_EMAIL });

    expect((await invite({ inviterId })).kind).toBe('created');
    expect(await openInvitations()).toHaveLength(1);
  });

  it('invites an account that is still pending verification', async () => {
    await seedAccount({ email: INVITED_EMAIL, status: 'pending_verification' });

    expect((await invite({ inviterId })).kind).toBe('created');
    expect(await openInvitations()).toHaveLength(1);
  });

  it('invites a disabled account without disclosing its state', async () => {
    await seedAccount({ email: INVITED_EMAIL, status: 'disabled' });

    expect((await invite({ inviterId })).kind).toBe('created');
  });

  it('invites an email whose membership is disabled', async () => {
    const invitedId = await seedAccount({ email: INVITED_EMAIL });
    await seedMembership({
      organizationId: ORGANIZATION_ID,
      userAccountId: invitedId,
      role: 'admin',
      status: 'disabled',
    });

    expect((await invite({ inviterId })).kind).toBe('created');
  });

  it('reports a conflict for an active membership in the target organization', async () => {
    const invitedId = await seedAccount({ email: INVITED_EMAIL });
    await seedMembership({
      organizationId: ORGANIZATION_ID,
      userAccountId: invitedId,
      role: 'member',
      status: 'active',
    });

    expect((await invite({ inviterId })).kind).toBe('member_exists');
    expect(await openInvitations()).toHaveLength(0);
  });

  it('does not treat an active membership in another organization as a conflict', async () => {
    await seedOrganization(OTHER_ORGANIZATION_ID);
    const invitedId = await seedAccount({ email: INVITED_EMAIL });
    await seedMembership({
      organizationId: OTHER_ORGANIZATION_ID,
      userAccountId: invitedId,
      role: 'owner',
      status: 'active',
    });

    expect((await invite({ inviterId })).kind).toBe('created');
  });

  it('closes the previous open invitation when the same email is invited again', async () => {
    const first = tokenHash();
    const second = tokenHash();

    await invite({ inviterId, tokenHash: first, role: 'member' });
    await invite({ inviterId, tokenHash: second, role: 'admin' });

    const open = await openInvitations();
    expect(open).toHaveLength(1);
    expect(open[0]?.token_hash).toBe(second);
    expect(open[0]?.role).toBe('admin');
    expect((await invitationByHash(first))?.consumed_at).not.toBeNull();
  });

  it('rejects a second open invitation for the same organization and email', async () => {
    await invite({ inviterId });

    await expect(
      insertInvitationRow({
        id: invitationId(),
        organizationId: ORGANIZATION_ID,
        email: INVITED_EMAIL,
        role: 'member',
        invitedBy: inviterId,
        tokenHash: tokenHash(),
        expiresAt: EXPIRES_AT,
        createdAt: NOW,
      }),
    ).rejects.toThrow(/organization_invitations_one_open/);
  });

  it.each([
    ['a malformed token hash', { token_hash: 'not-a-sha-256-hash' }],
    ['an unknown role', { role: 'superuser' }],
    ['an expiry at or before creation', { expires_at: NOW }],
  ])('rejects %s durably', async (_label, overrides) => {
    const row = {
      id: invitationId(),
      organization_id: ORGANIZATION_ID,
      email: INVITED_EMAIL,
      role: 'member',
      invited_by: inviterId,
      token_hash: tokenHash(),
      expires_at: EXPIRES_AT,
      created_at: NOW,
      ...overrides,
    };

    // 23514 is check_violation: the row must be refused by a constraint, not
    // by a typo or a dropped connection.
    await expect(
      insertInvitationRow({
        id: row.id,
        organizationId: row.organization_id,
        email: row.email,
        role: row.role,
        invitedBy: row.invited_by,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('organization invitation acceptance against PostgreSQL', () => {
  let inviterId: string;
  let token: string;

  beforeEach(async () => {
    inviterId = await seedInviterOwner();
    token = tokenHash();
  });

  it('creates the membership with the invited role and consumes the token', async () => {
    await invite({ inviterId, tokenHash: token, role: 'admin' });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });

    const result = await accept({ accepterId, tokenHash: token });

    expect(result).toEqual({
      kind: 'accepted',
      organizationId: ORGANIZATION_ID,
      role: 'admin',
    });
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toEqual({
      role: 'admin',
      status: 'active',
    });
    expect((await invitationByHash(token))?.consumed_at).not.toBeNull();
  });

  it('reactivates a disabled membership with the invitation role, not the stale one', async () => {
    const accepterId = await seedAccount({ email: INVITED_EMAIL });
    await seedMembership({
      organizationId: ORGANIZATION_ID,
      userAccountId: accepterId,
      role: 'admin',
      status: 'disabled',
    });
    await invite({ inviterId, tokenHash: token, role: 'member' });

    const result = await accept({ accepterId, tokenHash: token });

    expect(result).toEqual({
      kind: 'accepted',
      organizationId: ORGANIZATION_ID,
      role: 'member',
    });
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toEqual({
      role: 'member',
      status: 'active',
    });
  });

  it('preserves an already-active membership role and still consumes the token', async () => {
    const accepterId = await seedAccount({ email: INVITED_EMAIL });
    await seedMembership({
      organizationId: ORGANIZATION_ID,
      userAccountId: accepterId,
      role: 'owner',
      status: 'active',
    });
    // The invite path rejects an active member, so this token can only come
    // from an invitation issued before that membership existed.
    await insertInvitationRow({
      id: invitationId(),
      organizationId: ORGANIZATION_ID,
      email: INVITED_EMAIL,
      role: 'member',
      invitedBy: inviterId,
      tokenHash: token,
      expiresAt: EXPIRES_AT,
      createdAt: NOW,
    });

    const result = await accept({ accepterId, tokenHash: token });

    expect(result).toEqual({
      kind: 'accepted',
      organizationId: ORGANIZATION_ID,
      role: 'owner',
    });
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toEqual({
      role: 'owner',
      status: 'active',
    });
    expect((await invitationByHash(token))?.consumed_at).not.toBeNull();
  });

  it('rejects an unknown token and writes nothing', async () => {
    const accepterId = await seedAccount({ email: INVITED_EMAIL });

    const result = await accept({
      accepterId,
      tokenHash: tokenHash(),
    });

    expect(result).toEqual({ kind: 'token_invalid' });
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toBeUndefined();
  });

  it('rejects an expired token without consuming it', async () => {
    await invite({ inviterId, tokenHash: token });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });

    const result = await accept({
      accepterId,
      tokenHash: token,
      now: new Date(EXPIRES_AT.getTime() + 1_000),
    });

    expect(result).toEqual({ kind: 'token_invalid' });
    expect((await invitationByHash(token))?.consumed_at).toBeNull();
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toBeUndefined();
  });

  it('rejects an already consumed token', async () => {
    await invite({ inviterId, tokenHash: token });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });
    await accept({ accepterId, tokenHash: token });

    const replay = await accept({ accepterId, tokenHash: token });

    expect(replay).toEqual({ kind: 'token_invalid' });
  });

  it('rejects a token superseded by a resend', async () => {
    const replacement = tokenHash();
    await invite({ inviterId, tokenHash: token });
    await invite({ inviterId, tokenHash: replacement });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });

    expect(await accept({ accepterId, tokenHash: token })).toEqual({
      kind: 'token_invalid',
    });
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toBeUndefined();

    expect(await accept({ accepterId, tokenHash: replacement })).toEqual({
      kind: 'accepted',
      organizationId: ORGANIZATION_ID,
      role: 'member',
    });
  });

  it('rejects an attempt from another account and leaves the token valid', async () => {
    await invite({ inviterId, tokenHash: token });
    const strangerId = await seedAccount({ email: 'stranger@example.com' });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });

    const stolen = await accept({
      accepterId: strangerId,
      tokenHash: token,
    });

    expect(stolen).toEqual({ kind: 'token_invalid' });
    expect((await invitationByHash(token))?.consumed_at).toBeNull();
    // The rightful invitee can still redeem it.
    expect(await accept({ accepterId, tokenHash: token })).toEqual({
      kind: 'accepted',
      organizationId: ORGANIZATION_ID,
      role: 'member',
    });
  });

  it.each([
    ['a disabled account', 'disabled' as const],
    ['an account pending verification', 'pending_verification' as const],
  ])('rejects %s without consuming the token', async (_label, status) => {
    await invite({ inviterId, tokenHash: token });
    const accepterId = await seedAccount({ email: INVITED_EMAIL, status });

    const result = await accept({ accepterId, tokenHash: token });

    expect(result).toEqual({ kind: 'token_invalid' });
    expect((await invitationByHash(token))?.consumed_at).toBeNull();
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toBeUndefined();
  });

  it('rejects acceptance into a suspended organization without consuming anything', async () => {
    await invite({ inviterId, tokenHash: token });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });
    await pool.query(
      `UPDATE organizations SET status = 'suspended' WHERE id = $1`,
      [ORGANIZATION_ID],
    );

    const result = await accept({ accepterId, tokenHash: token });

    expect(result).toEqual({ kind: 'organization_suspended' });
    expect((await invitationByHash(token))?.consumed_at).toBeNull();
    expect(await membershipRow(ORGANIZATION_ID, accepterId)).toBeUndefined();
  });

  it('claims the invitation row, so a redemption blocks on the holder instead of reading around it', async () => {
    await invite({ inviterId, tokenHash: token });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const holderPid = await holder
        .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        .then(({ rows }) => rows[0]?.pid);
      await holder.query(
        `SELECT id FROM organization_invitations
         WHERE token_hash = $1 FOR UPDATE`,
        [token],
      );

      let settled = false;
      const redemption = accept({ accepterId, tokenHash: token }).then(
        (result) => {
          settled = true;
          return result;
        },
      );

      // Asked of the engine rather than of the clock: some backend must be
      // waiting on the holder. A repository that read the row without claiming
      // it would sail past and grant a second membership, and would never
      // appear here however slow the runner is.
      await waitForBlockedBy(pool, holderPid);
      expect(settled).toBe(false);

      await holder.query(
        `UPDATE organization_invitations SET consumed_at = $2
         WHERE token_hash = $1 AND consumed_at IS NULL`,
        [token, NOW],
      );
      await holder.query('COMMIT');

      // Released, it re-evaluates against the committed row and finds the
      // token spent rather than granting a second membership.
      await expect(redemption).resolves.toEqual({ kind: 'token_invalid' });
      expect(await membershipRow(ORGANIZATION_ID, accepterId)).toBeUndefined();
    } finally {
      holder.release(true);
    }
  });

  it('grants exactly one redemption when four race for the same token', async () => {
    await invite({ inviterId, tokenHash: token });
    const accepterId = await seedAccount({ email: INVITED_EMAIL });

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => accept({ accepterId, tokenHash: token })),
    );

    // A repository that granted every racer would spend one invitation four
    // times over.
    expect(outcomes.filter(({ kind }) => kind === 'accepted')).toHaveLength(1);
    expect(
      outcomes.filter(({ kind }) => kind === 'token_invalid'),
    ).toHaveLength(3);
    expect((await invitationByHash(token))?.consumed_at).not.toBeNull();
  });

  it('rolls the supersede back when the replacement cannot be inserted', async () => {
    const replaced = tokenHash();
    await invite({ inviterId, tokenHash: replaced });
    const collidingId = (await openInvitations())[0]?.id as string;

    // Reusing the existing invitation id makes the insert fail after the
    // previous invitation has already been closed, so only an atomic resend
    // leaves the original usable.
    await expect(
      invite({ inviterId, invitationId: collidingId }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect((await invitationByHash(replaced))?.consumed_at).toBeNull();
    expect(await openInvitations()).toHaveLength(1);
  });
});

import type { RequestContext } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { SHARE_MEMBERSHIP_AUTHORITY_SQL } from './organization-invitation-membership-authority';
import {
  ACCEPTING_ACCOUNT_SQL,
  FIND_INVITATION_SQL,
  LOCK_INVITATION_SQL,
  LOCK_ORGANIZATION_FOR_ACCEPTANCE_SQL,
  PostgresOrganizationInvitationAcceptRepository,
  UPSERT_MEMBERSHIP_SQL,
} from './postgres-organization-invitation-accept.repository';
import { PostgresOrganizationInvitationCreateRepository } from './postgres-organization-invitation-create.repository';
import { PostgresOrganizationInvitationReadRepository } from './postgres-organization-invitation-read.repository';
import { PostgresOrganizationInvitationRevokeRepository } from './postgres-organization-invitation-revoke.repository';

function context(organizationId?: string): RequestContext {
  return createRequestContext({
    requestId: 'req_01J00000000000000000000000',
    receivedAt: new Date('2026-09-21T00:00:00.000Z'),
    deadlineMs: 5_000,
    userId: 'usr_actor',
    ...(organizationId === undefined ? {} : { organizationId }),
    scopes: [],
  });
}

const now = new Date('2026-09-21T00:00:00.000Z');
const emailOutbox: EmailOutboxPort = {
  withAdmission: async (_kind, operation) => operation(),
  reserveAuthenticationEmailRecipient: async () => true,
  queue: async () => undefined,
  withdraw: async () => undefined,
};

const INVALID_INPUT = {
  message: 'Identity organization invitation input is invalid',
};

const organizationScoped = [
  {
    name: 'create',
    invoke: (prisma: ScriptedPrisma, ctx: RequestContext) =>
      new PostgresOrganizationInvitationCreateRepository(
        prisma.client(),
        emailOutbox,
      ).createInvitation({
        context: ctx,
        invitationId: 'oin_01J00000000000000000000000',
        organizationId: 'org_acme',
        email: 'member@example.test',
        role: 'member',
        invitedBy: 'usr_actor',
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(now.getTime() + 60_000),
        emailDelivery: { token: 'opaque-token', createdAt: now },
        now,
      }),
  },
  {
    name: 'read',
    invoke: (prisma: ScriptedPrisma, ctx: RequestContext) =>
      new PostgresOrganizationInvitationReadRepository(
        prisma.client(),
      ).listOpenInvitations({
        context: ctx,
        userId: 'usr_actor',
        organizationId: 'org_acme',
        now,
        limit: 100,
      }),
  },
  {
    name: 'revoke',
    invoke: (prisma: ScriptedPrisma, ctx: RequestContext) =>
      new PostgresOrganizationInvitationRevokeRepository(
        prisma.client(),
      ).revokeInvitation({
        context: ctx,
        actorUserId: 'usr_actor',
        organizationId: 'org_acme',
        invitationId: 'oin_01J00000000000000000000000',
        now,
      }),
  },
] as const;

function accept(prisma: ScriptedPrisma, ctx: RequestContext) {
  return new PostgresOrganizationInvitationAcceptRepository(
    prisma.client(),
  ).acceptInvitation({
    context: ctx,
    userId: 'usr_actor',
    tokenHash: 'a'.repeat(64),
    now,
  });
}

describe('Organization Invitation operation repositories', () => {
  it.each(organizationScoped)(
    '$name repository requires its Organization context',
    async ({ invoke }) => {
      for (const organizationId of [undefined, 'org_other']) {
        const prisma = new ScriptedPrisma();

        await expect(
          invoke(prisma, context(organizationId)),
        ).rejects.toMatchObject(INVALID_INPUT);
        expect(prisma.opened).toBe(0);
        expect(prisma.statements).toHaveLength(0);
      }
    },
  );

  it('accept repository forbids Organization context', async () => {
    const prisma = new ScriptedPrisma();

    await expect(accept(prisma, context('org_acme'))).rejects.toMatchObject(
      INVALID_INPUT,
    );
    expect(prisma.opened).toBe(0);
    expect(prisma.statements).toHaveLength(0);
  });

  it('accept repository rejects an unknown token inside one transaction', async () => {
    const prisma = new ScriptedPrisma();

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'token_invalid',
    });
    expect(prisma.opened).toBe(1);
    expect(prisma.statements).toHaveLength(1);
  });
});

/**
 * The columns one raw SELECT returns, read from its text: the identifiers and
 * `AS` aliases of the select (or returning) list. A scripted row must name
 * exactly these, so a mock cannot hand a reader a column the statement never
 * returns — the masking that hid the unaliased `status` column #447 fixed.
 */
function returnedColumns(sql: string): readonly string[] {
  const returning = /\bRETURNING\b([\s\S]*)$/i.exec(sql);
  const select =
    returning === null
      ? /(?:^|\n)\s*SELECT\b([\s\S]*?)(?:\n\s*FROM\b|\n\s*$)/i.exec(sql)
      : undefined;
  const segment = returning?.[1] ?? select?.[1];
  if (segment === undefined) {
    throw new Error(`spec cannot read the returned columns of: ${sql}`);
  }
  return segment
    .split(',')
    .map((part) => /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(part.trim())?.[1])
    .filter((column): column is string => column !== undefined);
}

/**
 * Scripts one raw statement's rows after checking the mock names exactly the
 * columns the SQL really returns. Rows must be pushed in statement order.
 */
function scriptRows(
  prisma: ScriptedPrisma,
  sql: string,
  ...rows: readonly Record<string, unknown>[]
): void {
  const columns = [...returnedColumns(sql)].sort();
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(columns);
  }
  prisma.inside.push(...rows.map((row) => [row]));
}

const OPEN_INVITATION_ROW = {
  id: 'oin_01J00000000000000000000000',
  organization_id: 'org_acme',
  email: 'member@example.test',
  invited_by: 'usr_inviter',
  token_hash: 'a'.repeat(64),
  consumed_at: null,
  expires_at: new Date(now.getTime() + 60_000),
};

/**
 * Scripts the reads acceptance makes before any grant: the unlocked
 * pre-read, the shared Organization lock, the locked invitation, the
 * accepting account, and the inviter's current Membership (ADR-0159).
 */
function acceptScenario(
  prisma: ScriptedPrisma,
  invitationRole: string,
  inviterMembership: Record<string, unknown> | undefined,
): void {
  scriptRows(prisma, FIND_INVITATION_SQL, {
    id: OPEN_INVITATION_ROW.id,
    organization_id: OPEN_INVITATION_ROW.organization_id,
  });
  scriptRows(prisma, LOCK_ORGANIZATION_FOR_ACCEPTANCE_SQL, {
    id: 'org_acme',
    status: 'active',
  });
  scriptRows(prisma, LOCK_INVITATION_SQL, {
    ...OPEN_INVITATION_ROW,
    role: invitationRole,
  });
  scriptRows(prisma, ACCEPTING_ACCOUNT_SQL, {
    canonical_email: 'member@example.test',
  });
  if (inviterMembership !== undefined) {
    scriptRows(prisma, SHARE_MEMBERSHIP_AUTHORITY_SQL, inviterMembership);
  }
}

describe('Organization Invitation inviter-authority admission (ADR-0159)', () => {
  it('refuses an invitation whose inviter can no longer grant its role', async () => {
    // Transfer-then-accept: the inviter was an owner when the invitation was
    // issued, then transferred ownership and became an admin. An admin cannot
    // grant owner, so acceptance refuses before any membership is written.
    const prisma = new ScriptedPrisma();
    acceptScenario(prisma, 'owner', {
      role: 'admin',
      membership_status: 'active',
    });

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'inviter_unauthorized',
    });
    expect(prisma.opened).toBe(1);
    expect(prisma.statements).toHaveLength(5);
  });

  it('refuses an invitation whose inviter was disabled', async () => {
    const prisma = new ScriptedPrisma();
    acceptScenario(prisma, 'admin', {
      role: 'owner',
      membership_status: 'disabled',
    });

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'inviter_unauthorized',
    });
    expect(prisma.statements).toHaveLength(5);
  });

  it('refuses an invitation whose inviter no longer belongs', async () => {
    const prisma = new ScriptedPrisma();
    acceptScenario(prisma, 'owner', undefined);

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'inviter_unauthorized',
    });
  });

  it('still accepts a lawful member invitation from an inviter now an admin', async () => {
    // Positive control: the transfer left the inviter an active admin, and an
    // active admin may grant member, so this invitation remains valid.
    const prisma = new ScriptedPrisma();
    acceptScenario(prisma, 'member', {
      role: 'admin',
      membership_status: 'active',
    });
    scriptRows(prisma, UPSERT_MEMBERSHIP_SQL, { role: 'member' });

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'accepted',
      organizationId: 'org_acme',
      role: 'member',
    });
    expect(prisma.opened).toBe(1);
  });

  it('still accepts an owner invitation from an inviter still an owner', async () => {
    const prisma = new ScriptedPrisma();
    acceptScenario(prisma, 'owner', {
      role: 'owner',
      membership_status: 'active',
    });
    scriptRows(prisma, UPSERT_MEMBERSHIP_SQL, { role: 'owner' });

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'accepted',
      organizationId: 'org_acme',
      role: 'owner',
    });
  });

  it('refuses a consumed token without touching the membership', async () => {
    // The pre-read only sees unconsumed tokens, so a token consumed between
    // the pre-read and the locked re-read is refused at the lock.
    const prisma = new ScriptedPrisma();
    scriptRows(prisma, FIND_INVITATION_SQL, {
      id: OPEN_INVITATION_ROW.id,
      organization_id: OPEN_INVITATION_ROW.organization_id,
    });
    scriptRows(prisma, LOCK_ORGANIZATION_FOR_ACCEPTANCE_SQL, {
      id: 'org_acme',
      status: 'active',
    });
    scriptRows(prisma, LOCK_INVITATION_SQL, {
      ...OPEN_INVITATION_ROW,
      role: 'member',
      consumed_at: now,
    });

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'token_invalid',
    });
    expect(prisma.statements).toHaveLength(3);
  });
});

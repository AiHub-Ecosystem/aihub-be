import type { RequestContext } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresOrganizationInvitationAcceptRepository } from './postgres-organization-invitation-accept.repository';
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
 * Scripts the three reads acceptance makes before any grant: the locked
 * invitation, the accepting account, and the inviter's current Membership
 * (ADR-0027 as amended, #447).
 */
function acceptScenario(
  prisma: ScriptedPrisma,
  invitationRole: string,
  inviterMembership: Record<string, unknown> | undefined,
): void {
  prisma.inside.push(
    [
      {
        id: 'oin_01J00000000000000000000000',
        organization_id: 'org_acme',
        email: 'member@example.test',
        role: invitationRole,
        invited_by: 'usr_inviter',
      },
    ],
    [{ organization_status: 'active', canonical_email: 'member@example.test' }],
    ...(inviterMembership === undefined ? [] : [[inviterMembership]]),
  );
}

describe('Organization Invitation inviter-authority admission (ADR-0027 as amended)', () => {
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
    expect(prisma.statements).toHaveLength(3);
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
    expect(prisma.statements).toHaveLength(3);
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
    prisma.inside.push([{ role: 'member' }]); // UPSERT_MEMBERSHIP_SQL

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
    prisma.inside.push([{ role: 'owner' }]);

    await expect(accept(prisma, context())).resolves.toEqual({
      kind: 'accepted',
      organizationId: 'org_acme',
      role: 'owner',
    });
  });
});

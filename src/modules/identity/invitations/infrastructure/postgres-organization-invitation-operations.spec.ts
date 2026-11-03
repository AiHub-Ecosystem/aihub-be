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
        actorRole: 'owner',
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

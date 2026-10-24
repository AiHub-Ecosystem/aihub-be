import type { RequestContext } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  EmailDeliveryRequestWriterPort,
  EmailPayloadCipherPort,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresOrganizationInvitationRepository } from './postgres-organization-invitation.repository';

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
const payloadCipher: EmailPayloadCipherPort = {
  encrypt: (plaintext) => plaintext,
  decrypt: (envelope) => envelope,
};
const emailRequests: EmailDeliveryRequestWriterPort = {
  reserveAuthenticationEmailRecipient: async () => true,
  insert: async () => undefined,
  queuedPayloadCiphertexts: async () => [],
  cancelQueued: async () => undefined,
};

function repository(prisma: ScriptedPrisma) {
  return new PostgresOrganizationInvitationRepository(
    prisma.client(),
    payloadCipher,
    emailRequests,
  );
}

const requiredMethods = [
  {
    name: 'createInvitation',
    invoke: (
      repo: PostgresOrganizationInvitationRepository,
      ctx: RequestContext,
    ) =>
      repo.createInvitation({
        context: ctx,
        invitationId: 'oin_01J00000000000000000000000',
        organizationId: 'org_acme',
        email: 'member@example.test',
        role: 'member',
        invitedBy: 'usr_actor',
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(now.getTime() + 60_000),
        emailDelivery: {
          id: 'edr_01J00000000000000000000000',
          token: 'opaque-token',
          createdAt: now,
        },
        now,
      }),
  },
  {
    name: 'listOpenInvitations',
    invoke: (
      repo: PostgresOrganizationInvitationRepository,
      ctx: RequestContext,
    ) =>
      repo.listOpenInvitations({
        context: ctx,
        userId: 'usr_actor',
        organizationId: 'org_acme',
        now,
      }),
  },
  {
    name: 'revokeInvitation',
    invoke: (
      repo: PostgresOrganizationInvitationRepository,
      ctx: RequestContext,
    ) =>
      repo.revokeInvitation({
        context: ctx,
        actorUserId: 'usr_actor',
        actorRole: 'owner',
        organizationId: 'org_acme',
        invitationId: 'oin_01J00000000000000000000000',
        now,
      }),
  },
] as const;

describe('PostgresOrganizationInvitationRepository organization context', () => {
  it.each(requiredMethods)(
    '$name requires its Organization context',
    async ({ invoke }) => {
      for (const organizationId of [undefined, 'org_other']) {
        const prisma = new ScriptedPrisma();

        await expect(
          invoke(repository(prisma), context(organizationId)),
        ).rejects.toMatchObject({
          message: 'Identity organization invitation input is invalid',
        });
        expect(prisma.opened).toBe(0);
        expect(prisma.statements).toHaveLength(0);
      }
    },
  );

  it('forbids Organization context when accepting an invitation', async () => {
    const prisma = new ScriptedPrisma();

    await expect(
      repository(prisma).acceptInvitation({
        context: context('org_acme'),
        userId: 'usr_actor',
        tokenHash: 'a'.repeat(64),
        now,
      }),
    ).rejects.toMatchObject({
      message: 'Identity organization invitation input is invalid',
    });
    expect(prisma.opened).toBe(0);
    expect(prisma.statements).toHaveLength(0);
  });

  it('accepts an invitation without Organization context', async () => {
    const prisma = new ScriptedPrisma();

    await expect(
      repository(prisma).acceptInvitation({
        context: context(),
        userId: 'usr_actor',
        tokenHash: 'a'.repeat(64),
        now,
      }),
    ).resolves.toEqual({ kind: 'token_invalid' });
    expect(prisma.opened).toBe(1);
    expect(prisma.statements).toHaveLength(1);
  });
});

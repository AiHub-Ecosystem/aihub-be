import { createRequestContext } from '@/common/request-context/request-context.factory';

import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { UNUSED_EMAIL_OUTBOX } from '@/modules/auth/testing/email-outbox.stub';
import type { OrganizationStatus } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { InviteOrganizationMember } from '@/modules/identity/invitations/application/invite-organization-member';
import type { OrganizationInvitationPort } from '@/modules/identity/invitations/application/organization-invitation.port';
import type { OrganizationInviteTokenPort } from '@/modules/identity/invitations/application/organization-invite-token.port';
import { RevokeOrganizationInvitation } from '@/modules/identity/invitations/application/revoke-organization-invitation';
import { PostgresOrganizationInvitationRepository } from '@/modules/identity/invitations/infrastructure/postgres-organization-invitation.repository';
import { ManageOrganizationMembership } from '@/modules/identity/membership/application/manage-organization-membership';
import { organizationSuspensionClosesSurface } from '@/modules/identity/membership/application/organization-membership.authorization';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import { PostgresOrganizationMembershipRepository } from '@/modules/identity/membership/infrastructure/postgres-organization-membership.repository';
import type { RenameOrganizationRecordInput } from '@/modules/identity/organizations/application/organization-rename-record.port';
import { PostgresOrganizationRenameRepository } from '@/modules/identity/organizations/infrastructure/postgres-organization-rename.repository';
import type { IdentityRepositoryClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const INVITATION_ID = 'oiv_01J00000000000000000000000';
const INVITED_EMAIL = 'alice@example.com';
const NOW = new Date('2026-10-24T12:00:00.000Z');
const TOKEN_HASH = 'a'.repeat(64);

/**
 * The rule under contract: a suspended Organization closes every management
 * surface (ADR-0044). One table drives each guarded surface with an active
 * owner — the most privileged caller suspension still refuses — so a surface
 * that stops consuming the shared predicate fails here. A new management
 * surface registers by adding its row, which is what makes a missing
 * registration visible in review instead of silent.
 */
describe('a suspended Organization closes every management surface', () => {
  describe('the rule, stated once', () => {
    it.each<[OrganizationStatus, boolean]>([
      ['active', false],
      ['suspended', true],
    ])(
      'with a %s Organization, the surface is closed: %j',
      (status, closed) => {
        expect(organizationSuspensionClosesSurface(status)).toBe(closed);
      },
    );
  });

  describe('application-tier surfaces', () => {
    function suspendedOwnerMembership(): Pick<
      OrganizationMembershipPort,
      'resolveMembership'
    > {
      return {
        resolveMembership: jest.fn(async ({ organizationId, userId }) => ({
          kind: 'active' as const,
          membership: {
            organizationId,
            userId,
            organizationStatus: 'suspended' as const,
            role: 'owner' as const,
            status: 'active' as const,
          },
        })),
      };
    }

    it('closes invitation creation', async () => {
      const invite = new InviteOrganizationMember(
        suspendedOwnerMembership(),
        {} as OrganizationInvitationPort,
        {} as OrganizationInviteTokenPort,
        {} as AuthRateLimiterPort,
        UNUSED_EMAIL_OUTBOX,
      );

      await expect(
        invite.authorize({
          context: managementContext(),
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          email: INVITED_EMAIL,
          role: 'member',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Organization invitation sending is forbidden',
      });
    });

    it('closes invitation revocation before the invitation is read', async () => {
      const invitations = {
        revokeInvitation: jest.fn(),
      };
      const revoke = new RevokeOrganizationInvitation(
        suspendedOwnerMembership(),
        invitations,
        () => NOW,
      );

      await expect(
        revoke.revoke({
          context: managementContext(),
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          invitationId: INVITATION_ID,
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Organization invitation revocation is forbidden',
      });
      expect(invitations.revokeInvitation).not.toHaveBeenCalled();
    });

    type MutationInput = Parameters<ManageOrganizationMembership['disable']>[0];

    it.each([
      [
        'role changes',
        (manage: ManageOrganizationMembership, input: MutationInput) =>
          manage.changeRole({ ...input, role: 'member' }),
        'Organization membership role change is forbidden',
      ],
      [
        'disabling',
        (manage: ManageOrganizationMembership, input: MutationInput) =>
          manage.disable(input),
        'Organization membership disable is forbidden',
      ],
      [
        'ownership transfers',
        (manage: ManageOrganizationMembership, input: MutationInput) =>
          manage.transfer(input),
        'Organization ownership transfer is forbidden',
      ],
    ])('closes membership %s', async (_, act, refusal) => {
      const membership: Pick<
        OrganizationMembershipPort,
        'resolveMembership' | 'changeRole' | 'disable' | 'transfer'
      > = {
        ...suspendedOwnerMembership(),
        changeRole: jest.fn(),
        disable: jest.fn(),
        transfer: jest.fn(),
      };
      const manage = new ManageOrganizationMembership(membership);

      await expect(
        act(manage, {
          context: managementContext(),
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          username: 'bob',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: refusal });
      expect(membership.changeRole).not.toHaveBeenCalled();
      expect(membership.disable).not.toHaveBeenCalled();
      expect(membership.transfer).not.toHaveBeenCalled();
    });
  });

  describe('decisions under the row locks', () => {
    /**
     * Answers the scripted locking reads in order and refuses any write, so a
     * surface that proceeds past a closed Organization trips here instead of
     * committing. The per-surface suites prove the SQL and the locks; this
     * proves only that closure is decided at the locked status.
     */
    function scriptedLocks(
      reads: readonly (readonly Record<string, unknown>[])[],
    ): IdentityRepositoryClient {
      let read = 0;
      return {
        $transaction: (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            $queryRawUnsafe: async () => {
              const rows = reads[read];
              read += 1;
              return rows ?? [];
            },
            $executeRawUnsafe: async () => {
              throw new Error('a closed surface must not write');
            },
          }),
      } as unknown as IdentityRepositoryClient;
    }

    it('closes invitation revocation at the organization lock', async () => {
      const db = scriptedLocks([
        [{ id: ORGANIZATION_ID, status: 'suspended' }],
      ]);
      const repository = new PostgresOrganizationInvitationRepository(
        db,
        UNUSED_EMAIL_OUTBOX,
      );

      await expect(
        repository.revokeInvitation({
          context: managementContext(),
          actorUserId: USER_ID,
          actorRole: 'owner',
          organizationId: ORGANIZATION_ID,
          invitationId: INVITATION_ID,
          now: NOW,
        }),
      ).resolves.toEqual({ kind: 'organization_suspended' });
    });

    it('closes invitation acceptance at the organization lock', async () => {
      const db = scriptedLocks([
        [
          {
            id: INVITATION_ID,
            organization_id: ORGANIZATION_ID,
            email: INVITED_EMAIL,
            role: 'member',
          },
        ],
        [
          {
            organization_status: 'suspended',
            canonical_email: INVITED_EMAIL,
          },
        ],
      ]);
      const repository = new PostgresOrganizationInvitationRepository(
        db,
        UNUSED_EMAIL_OUTBOX,
      );

      await expect(
        repository.acceptInvitation({
          context: bearerContext(),
          userId: USER_ID,
          tokenHash: TOKEN_HASH,
          now: NOW,
        }),
      ).resolves.toEqual({ kind: 'organization_suspended' });
    });

    it('closes membership mutations at the organization lock', async () => {
      const db = scriptedLocks([
        [{ id: ORGANIZATION_ID, status: 'suspended' }],
        [
          {
            organization_id: ORGANIZATION_ID,
            user_account_id: USER_ID,
            username: 'alice',
            role: 'owner',
            membership_status: 'active',
          },
        ],
      ]);
      const repository = new PostgresOrganizationMembershipRepository(db);

      await expect(
        repository.disable({
          context: managementContext(),
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          username: 'alice',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Organization membership disable is forbidden',
      });
    });

    it('closes Organization rename at the organization lock', async () => {
      const db = scriptedLocks([
        [{ id: ORGANIZATION_ID, name: 'Acme', status: 'suspended' }],
        [{ role: 'owner', status: 'active' }],
      ]);
      const repository = new PostgresOrganizationRenameRepository(db);
      const input: RenameOrganizationRecordInput = {
        context: bearerContext(),
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        name: 'Acme Learning',
      };

      await expect(repository.renameOrganization(input)).resolves.toEqual({
        kind: 'forbidden',
      });
    });
  });
});

function managementContext() {
  return createRequestContext({
    requestId: 'req_01J00000000000000000000000',
    receivedAt: NOW,
    deadlineMs: 5_000,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    scopes: [],
  });
}

/** Acceptance is a Bearer-boundary surface, so its context names no Organization. */
function bearerContext() {
  return createRequestContext({
    requestId: 'req_01J00000000000000000000000',
    receivedAt: NOW,
    deadlineMs: 5_000,
    userId: USER_ID,
    scopes: [],
  });
}

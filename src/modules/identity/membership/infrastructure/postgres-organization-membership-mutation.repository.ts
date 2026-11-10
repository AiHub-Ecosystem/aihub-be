import { isRecord } from '@/common/is-record';
import { recordOrganizationAuditEvent } from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { demotesOrganizationMembershipRole } from '@/modules/identity/membership/application/organization-membership.mutation-policy';
import type {
  ChangeOrganizationMemberRoleInput,
  OrganizationMembershipMutationInput,
  OrganizationMembershipMutationResult,
  OrganizationMembershipPort,
} from '@/modules/identity/membership/application/organization-membership.port';
import {
  invalidIdentityData,
  membershipRoleValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import {
  CHANGE_ROLE_SQL,
  DEMOTE_TRANSFER_CALLER_SQL,
  DISABLE_MEMBERSHIP_SQL,
  MEMBER_HANDLED_API_KEYS_SQL,
  PROMOTE_TRANSFER_TARGET_SQL,
  isLastActiveOwner,
  mapHandledApiKeys,
  mapUpdatedMembership,
  membershipDisabledAuditDraft,
  mutationResult,
  ownerRequired,
  ownerTransferredAuditDraft,
  roleChangedAuditDraft,
  runAuthorizedMutation,
} from './postgres-organization-membership-mutation-support';

export class PostgresOrganizationMembershipMutationRepository
  implements
    Pick<OrganizationMembershipPort, 'changeRole' | 'disable' | 'transfer'>
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  changeRole(
    input: ChangeOrganizationMemberRoleInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return runAuthorizedMutation(
      this.client,
      input,
      'change_role',
      (target) =>
        roleChangedAuditDraft(target, input.role, 'insufficient_authority'),
      async ({ transaction, target, stamp, refuse }) => {
        if (target.role === input.role) {
          return mutationResult(target);
        }
        if (
          target.role === 'owner' &&
          (await isLastActiveOwner(transaction, input.organizationId))
        ) {
          refuse(roleChangedAuditDraft(target, input.role, 'owner_required'));
          throw ownerRequired();
        }

        const rows = await identityRows(transaction, CHANGE_ROLE_SQL, [
          input.organizationId,
          target.userId,
          input.role,
        ]);
        const updated = mapUpdatedMembership(rows[0]);
        await recordOrganizationAuditEvent(
          transaction,
          stamp,
          roleChangedAuditDraft(target, updated.role),
        );
        // A demotion removes authority the member's API keys still act with;
        // the same transaction surfaces those keys for review or revocation.
        const handledApiKeys = demotesOrganizationMembershipRole(
          target.role,
          updated.role,
        )
          ? mapHandledApiKeys(
              await identityRows(transaction, MEMBER_HANDLED_API_KEYS_SQL, [
                input.organizationId,
                target.userId,
              ]),
            )
          : undefined;
        return mutationResult(
          target,
          updated.role,
          updated.status,
          handledApiKeys,
        );
      },
    );
  }

  disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return runAuthorizedMutation(
      this.client,
      input,
      'disable',
      (target) =>
        membershipDisabledAuditDraft(target, 'insufficient_authority'),
      async ({ transaction, target, stamp, refuse }) => {
        if (target.status === 'disabled') {
          return mutationResult(target);
        }
        if (
          target.role === 'owner' &&
          (await isLastActiveOwner(transaction, input.organizationId))
        ) {
          refuse(membershipDisabledAuditDraft(target, 'owner_required'));
          throw ownerRequired();
        }

        const rows = await identityRows(transaction, DISABLE_MEMBERSHIP_SQL, [
          input.organizationId,
          target.userId,
        ]);
        const updated = mapUpdatedMembership(rows[0]);
        if (updated.status !== 'disabled') {
          throw invalidIdentityData();
        }
        await recordOrganizationAuditEvent(
          transaction,
          stamp,
          membershipDisabledAuditDraft(target),
        );
        // The disabled member's API keys still act with the authority the
        // disable removed; the same transaction surfaces them for review or
        // revocation.
        return mutationResult(
          target,
          updated.role,
          updated.status,
          mapHandledApiKeys(
            await identityRows(transaction, MEMBER_HANDLED_API_KEYS_SQL, [
              input.organizationId,
              target.userId,
            ]),
          ),
        );
      },
    );
  }

  transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return runAuthorizedMutation(
      this.client,
      input,
      'transfer',
      (target, caller) =>
        ownerTransferredAuditDraft(
          target,
          caller.username,
          'insufficient_authority',
        ),
      async ({ transaction, caller, target, stamp }) => {
        const promotedRows = await identityRows(
          transaction,
          PROMOTE_TRANSFER_TARGET_SQL,
          [input.organizationId, target.userId],
        );
        const promoted = mapUpdatedMembership(promotedRows[0]);
        if (promoted.role !== 'owner' || promoted.status !== 'active') {
          throw invalidIdentityData();
        }

        const demotedRows = await identityRows(
          transaction,
          DEMOTE_TRANSFER_CALLER_SQL,
          [input.organizationId, caller.userId],
        );
        const demoted = demotedRows[0];
        const demotedRole = isRecord(demoted)
          ? membershipRoleValue(demoted, 'role')
          : undefined;
        if (demotedRole !== 'admin') {
          throw invalidIdentityData();
        }

        // Transfer is atomic and produces one event for both role changes.
        await recordOrganizationAuditEvent(
          transaction,
          stamp,
          ownerTransferredAuditDraft(target, caller.username),
        );
        return mutationResult(target, promoted.role, promoted.status);
      },
    );
  }
}

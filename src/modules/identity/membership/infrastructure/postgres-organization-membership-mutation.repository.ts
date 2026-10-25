import { recordOrganizationAuditEvent } from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL } from '@/modules/identity/membership/application/organization-membership.mutation-policy';
import type {
  ChangeOrganizationMemberRoleInput,
  OrganizationMembershipMutationInput,
  OrganizationMembershipMutationResult,
  OrganizationMembershipPort,
} from '@/modules/identity/membership/application/organization-membership.port';
import {
  identityStoreError,
  isRecord,
  membershipRoleValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import {
  CHANGE_ROLE_SQL,
  DEMOTE_TRANSFER_CALLER_SQL,
  DISABLE_MEMBERSHIP_SQL,
  PROMOTE_TRANSFER_TARGET_SQL,
  isLastActiveOwner,
  lockMutationContext,
  mapUpdatedMembership,
  membershipDisabledAuditDraft,
  mutationDecision,
  mutationResult,
  ownerRequired,
  ownerTransferredAuditDraft,
  prepareMembershipMutation,
  requireAuthorizedMutationTarget,
  roleChangedAuditDraft,
} from './postgres-organization-membership-mutation-support';

export class PostgresOrganizationMembershipMutationRepository
  implements
    Pick<OrganizationMembershipPort, 'changeRole' | 'disable' | 'transfer'>
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  async changeRole(
    input: ChangeOrganizationMemberRoleInput,
  ): Promise<OrganizationMembershipMutationResult> {
    const mutation = prepareMembershipMutation(this.client, input, {
      kind: 'required',
      organizationId: input.organizationId,
    });
    try {
      return await identityTransaction(this.client, async (transaction) => {
        const { caller, target } = await lockMutationContext(
          transaction,
          input,
          ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL.change_role,
        );
        const decision = mutationDecision('change_role', caller, target);
        if (target !== undefined && decision?.kind === 'forbidden') {
          mutation.refuse(
            roleChangedAuditDraft(target, input.role, 'insufficient_authority'),
          );
        }
        const authorizedTarget = requireAuthorizedMutationTarget(
          'change_role',
          caller,
          target,
          decision,
        );
        if (authorizedTarget.role === input.role) {
          return mutationResult(authorizedTarget);
        }
        if (
          authorizedTarget.role === 'owner' &&
          (await isLastActiveOwner(transaction, input.organizationId))
        ) {
          mutation.refuse(
            roleChangedAuditDraft(
              authorizedTarget,
              input.role,
              'owner_required',
            ),
          );
          throw ownerRequired();
        }

        const rows = await identityRows(transaction, CHANGE_ROLE_SQL, [
          input.organizationId,
          authorizedTarget.userId,
          input.role,
        ]);
        const updated = mapUpdatedMembership(rows[0]);
        await recordOrganizationAuditEvent(
          transaction,
          mutation.stamp,
          roleChangedAuditDraft(authorizedTarget, updated.role),
        );
        return mutationResult(authorizedTarget, updated.role, updated.status);
      });
    } catch (error) {
      return mutation.rethrow(error);
    }
  }

  async disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    const mutation = prepareMembershipMutation(this.client, input, {
      kind: 'required',
      organizationId: input.organizationId,
    });
    try {
      return await identityTransaction(this.client, async (transaction) => {
        const { caller, target } = await lockMutationContext(
          transaction,
          input,
          ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL.disable,
        );
        const decision = mutationDecision('disable', caller, target);
        if (target !== undefined && decision?.kind === 'forbidden') {
          mutation.refuse(
            membershipDisabledAuditDraft(target, 'insufficient_authority'),
          );
        }
        const authorizedTarget = requireAuthorizedMutationTarget(
          'disable',
          caller,
          target,
          decision,
        );
        if (authorizedTarget.status === 'disabled') {
          return mutationResult(authorizedTarget);
        }
        if (
          authorizedTarget.role === 'owner' &&
          (await isLastActiveOwner(transaction, input.organizationId))
        ) {
          mutation.refuse(
            membershipDisabledAuditDraft(authorizedTarget, 'owner_required'),
          );
          throw ownerRequired();
        }

        const rows = await identityRows(transaction, DISABLE_MEMBERSHIP_SQL, [
          input.organizationId,
          authorizedTarget.userId,
        ]);
        const updated = mapUpdatedMembership(rows[0]);
        if (updated.status !== 'disabled') {
          throw identityStoreError('Identity data is invalid');
        }
        await recordOrganizationAuditEvent(
          transaction,
          mutation.stamp,
          membershipDisabledAuditDraft(authorizedTarget),
        );
        return mutationResult(authorizedTarget, updated.role, updated.status);
      });
    } catch (error) {
      return mutation.rethrow(error);
    }
  }

  async transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    const mutation = prepareMembershipMutation(this.client, input, {
      kind: 'required',
      organizationId: input.organizationId,
    });
    try {
      return await identityTransaction(this.client, async (transaction) => {
        const { caller, target } = await lockMutationContext(
          transaction,
          input,
          ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL.transfer,
        );
        const decision = mutationDecision('transfer', caller, target);
        if (target !== undefined && decision?.kind === 'forbidden') {
          mutation.refuse(
            ownerTransferredAuditDraft(
              target,
              caller.username,
              'insufficient_authority',
            ),
          );
        }
        const authorizedTarget = requireAuthorizedMutationTarget(
          'transfer',
          caller,
          target,
          decision,
        );

        const promotedRows = await identityRows(
          transaction,
          PROMOTE_TRANSFER_TARGET_SQL,
          [input.organizationId, authorizedTarget.userId],
        );
        const promoted = mapUpdatedMembership(promotedRows[0]);
        if (promoted.role !== 'owner' || promoted.status !== 'active') {
          throw identityStoreError('Identity data is invalid');
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
          throw identityStoreError('Identity data is invalid');
        }

        // Transfer is atomic and produces one event for both role changes.
        await recordOrganizationAuditEvent(
          transaction,
          mutation.stamp,
          ownerTransferredAuditDraft(authorizedTarget, caller.username),
        );
        return mutationResult(authorizedTarget, promoted.role, promoted.status);
      });
    } catch (error) {
      return mutation.rethrow(error);
    }
  }
}

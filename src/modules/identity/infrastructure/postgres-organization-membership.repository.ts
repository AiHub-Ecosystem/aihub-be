import { AppError } from '../../../common/errors/app-error';
import type { OrganizationStatus } from '../application/api-key-authenticator.port';
import { authorizeOrganizationMembershipMutation } from '../application/organization-membership.mutation-policy';
import type {
  ChangeOrganizationMemberRoleInput,
  ListRosterInput,
  OrganizationMembershipMutationInput,
  OrganizationMembershipMutationResult,
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  OrganizationMembershipResolution,
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
  OrganizationRosterOrganization,
  ResolveMembershipInput,
} from '../application/organization-membership.port';
import type {
  OrganizationAuditDenial,
  OrganizationAuditDraft,
} from '../domain/organization-audit-event';

import {
  identityStoreError,
  isRecord,
  membershipRoleValue,
  membershipStatusValue,
  organizationStatusValue,
  stringValue,
} from './identity-row';
import {
  auditStamp,
  recordOrganizationAuditDenial,
  recordOrganizationAuditEvent,
} from './organization-audit-event.store';
import type { PostgresIdentityClient } from './postgres-api-key.repository';
import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';

const RESOLVE_MEMBERSHIP_SQL = `
  SELECT
    membership.organization_id,
    membership.user_account_id,
    organization.status AS organization_status,
    membership.role,
    membership.status AS membership_status
  FROM organization_members AS membership
  INNER JOIN organizations AS organization
    ON organization.id = membership.organization_id
  WHERE membership.user_account_id = $1
    AND membership.organization_id = $2
  LIMIT 1
`;

const LIST_ROSTER_SQL = `
  SELECT
    caller.organization_id,
    organization.name AS organization_name,
    organization.status AS organization_status,
    caller.role AS caller_role,
    member_account.username AS member_username,
    member.role AS member_role
  FROM organization_members AS caller
  INNER JOIN organizations AS organization
    ON organization.id = caller.organization_id
  INNER JOIN organization_members AS member
    ON member.organization_id = caller.organization_id
   AND member.status = 'active'
  INNER JOIN user_accounts AS member_account
    ON member_account.id = member.user_account_id
  WHERE caller.user_account_id = $1
    AND caller.status = 'active'
  ORDER BY caller.organization_id ASC, member_account.username ASC
`;

const LOCK_ORGANIZATION_FOR_MUTATION_SQL = `
  SELECT id, status
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

const LOCK_MEMBERSHIPS_FOR_MUTATION_SQL = `
  SELECT
    membership.organization_id,
    membership.user_account_id,
    member_account.username,
    membership.role,
    membership.status AS membership_status
  FROM organization_members AS membership
  INNER JOIN user_accounts AS member_account
    ON member_account.id = membership.user_account_id
  WHERE membership.organization_id = $1
    AND (
      membership.user_account_id = $2
      OR member_account.username = $3
    )
  ORDER BY membership.user_account_id ASC
  FOR UPDATE OF membership
`;

const COUNT_ACTIVE_OWNERS_SQL = `
  SELECT COUNT(*)::int AS owner_count
  FROM organization_members
  WHERE organization_id = $1
    AND role = 'owner'
    AND status = 'active'
`;

const CHANGE_ROLE_SQL = `
  UPDATE organization_members
  SET role = $3
  WHERE organization_id = $1
    AND user_account_id = $2
    AND status = 'active'
  RETURNING role, status AS membership_status
`;

const DISABLE_MEMBERSHIP_SQL = `
  UPDATE organization_members
  SET status = 'disabled'
  WHERE organization_id = $1
    AND user_account_id = $2
    AND status = 'active'
  RETURNING role, status AS membership_status
`;

const PROMOTE_TRANSFER_TARGET_SQL = `
  UPDATE organization_members
  SET role = 'owner'
  WHERE organization_id = $1
    AND user_account_id = $2
    AND status = 'active'
  RETURNING role, status AS membership_status
`;

const DEMOTE_TRANSFER_CALLER_SQL = `
  UPDATE organization_members
  SET role = 'admin'
  WHERE organization_id = $1
    AND user_account_id = $2
    AND role = 'owner'
    AND status = 'active'
`;

function mapMembershipRecord(
  value: unknown,
): OrganizationMembershipRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organization_id');
  const userId = stringValue(value, 'user_account_id');
  const organizationStatus = organizationStatusValue(
    value,
    'organization_status',
  );
  const role = membershipRoleValue(value, 'role');
  const status = membershipStatusValue(value, 'membership_status');

  if (
    organizationId === undefined ||
    userId === undefined ||
    organizationStatus === undefined ||
    role === undefined ||
    status === undefined
  ) {
    return undefined;
  }

  return {
    organizationId,
    userId,
    organizationStatus,
    role,
    status,
  };
}

interface RosterRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationStatus: OrganizationStatus;
  readonly callerRole: OrganizationMembershipRole;
  readonly memberUsername: string;
  readonly memberRole: OrganizationMembershipRole;
}

interface MutationMembershipRow {
  readonly organizationId: string;
  readonly userId: string;
  readonly username: string;
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
}

function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
}

function notFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Resource not found',
    retryable: false,
  });
}

function invalidMutation(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    retryable: false,
  });
}

function ownerRequired(): AppError {
  return new AppError({
    code: 'ORGANIZATION_OWNER_REQUIRED',
    message: 'Organization must retain an owner',
    retryable: false,
  });
}

function mapMutationMembershipRow(
  value: unknown,
): MutationMembershipRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organization_id');
  const userId = stringValue(value, 'user_account_id');
  const username = stringValue(value, 'username');
  const role = membershipRoleValue(value, 'role');
  const status = membershipStatusValue(value, 'membership_status');

  if (
    organizationId === undefined ||
    userId === undefined ||
    username === undefined ||
    role === undefined ||
    status === undefined
  ) {
    return undefined;
  }

  return { organizationId, userId, username, role, status };
}

function ownerCount(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const raw = value.owner_count;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    return Number(raw);
  }
  return undefined;
}

function mutationResult(
  target: MutationMembershipRow,
  role: OrganizationMembershipRole = target.role,
  status: OrganizationMembershipStatus = target.status,
): OrganizationMembershipMutationResult {
  return {
    organizationId: target.organizationId,
    username: target.username,
    role,
    status,
  };
}

/**
 * The audit draft for one membership act. The target's role and username are
 * read from the locked row, so the record keeps the authority the target
 * actually held at that moment rather than the one a later read would find.
 */
function membershipAuditDraft(
  action: 'change_role' | 'disable' | 'transfer',
  target: MutationMembershipRow,
  callerUsername: string,
  toRole: OrganizationMembershipRole | undefined,
  denial?: OrganizationAuditDenial,
): OrganizationAuditDraft {
  const refused = denial === undefined ? {} : { denial };

  if (action === 'change_role') {
    if (toRole === undefined) {
      throw identityStoreError('Identity data is invalid');
    }
    return {
      action: 'membership.role_changed',
      targetUserAccountId: target.userId,
      username: target.username,
      fromRole: target.role,
      toRole,
      ...refused,
    };
  }

  if (action === 'disable') {
    return {
      action: 'membership.disabled',
      targetUserAccountId: target.userId,
      username: target.username,
      role: target.role,
      ...refused,
    };
  }

  return {
    action: 'membership.owner_transferred',
    targetUserAccountId: target.userId,
    username: target.username,
    fromRole: target.role,
    previousOwnerUsername: callerUsername,
    ...refused,
  };
}

function mapRosterRow(value: unknown): RosterRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organization_id');
  const organizationName = stringValue(value, 'organization_name');
  const organizationStatus = organizationStatusValue(
    value,
    'organization_status',
  );
  const callerRole = membershipRoleValue(value, 'caller_role');
  const memberUsername = stringValue(value, 'member_username');
  const memberRole = membershipRoleValue(value, 'member_role');

  if (
    organizationId === undefined ||
    organizationName === undefined ||
    organizationStatus === undefined ||
    callerRole === undefined ||
    memberUsername === undefined ||
    memberRole === undefined
  ) {
    return undefined;
  }

  return {
    organizationId,
    organizationName,
    organizationStatus,
    callerRole,
    memberUsername,
    memberRole,
  };
}

function groupRosterRows(
  rows: readonly unknown[],
): readonly OrganizationRosterOrganization[] {
  const organizations = new Map<
    string,
    {
      readonly organizationId: string;
      readonly name: string;
      readonly status: OrganizationStatus;
      readonly membershipRole: OrganizationMembershipRole;
      readonly members: OrganizationRosterOrganization['members'][number][];
    }
  >();

  for (const rawRow of rows) {
    const row = mapRosterRow(rawRow);
    if (row === undefined) {
      throw identityStoreError('Identity data is invalid');
    }

    const existing = organizations.get(row.organizationId);
    if (existing === undefined) {
      organizations.set(row.organizationId, {
        organizationId: row.organizationId,
        name: row.organizationName,
        status: row.organizationStatus,
        membershipRole: row.callerRole,
        members: [{ username: row.memberUsername, role: row.memberRole }],
      });
      continue;
    }

    if (
      existing.name !== row.organizationName ||
      existing.status !== row.organizationStatus ||
      existing.membershipRole !== row.callerRole
    ) {
      throw identityStoreError('Identity data is invalid');
    }

    existing.members.push({
      username: row.memberUsername,
      role: row.memberRole,
    });
  }

  return [...organizations.values()];
}

export class PostgresOrganizationMembershipRepository
  implements OrganizationMembershipPort
{
  constructor(
    private readonly client: PostgresIdentityClient &
      PostgresIdentityTransactionalClient,
  ) {}

  async resolveMembership(
    input: ResolveMembershipInput,
  ): Promise<OrganizationMembershipResolution> {
    if (
      input.context.userId !== input.userId ||
      (input.context.organizationId !== undefined &&
        input.context.organizationId !== input.organizationId) ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0
    ) {
      throw identityStoreError(
        'Identity organization membership input is invalid',
      );
    }

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(RESOLVE_MEMBERSHIP_SQL, [
        input.userId,
        input.organizationId,
      ]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }

    const first = rows[0];
    if (first === undefined) {
      return { kind: 'missing' };
    }

    const membership = mapMembershipRecord(first);
    if (
      membership === undefined ||
      membership.userId !== input.userId ||
      membership.organizationId !== input.organizationId
    ) {
      throw identityStoreError('Identity data is invalid');
    }

    return membership.status === 'active'
      ? { kind: 'active', membership }
      : { kind: 'disabled', membership };
  }

  async listRoster(
    input: ListRosterInput,
  ): Promise<readonly OrganizationRosterOrganization[]> {
    if (
      input.context.userId !== input.userId ||
      input.userId.trim().length === 0
    ) {
      throw identityStoreError('Identity user id is invalid');
    }

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(LIST_ROSTER_SQL, [input.userId]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }

    return groupRosterRows(rows);
  }

  async changeRole(
    input: ChangeOrganizationMemberRoleInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutate(input, 'change_role', input.role);
  }

  async disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutate(input, 'disable');
  }

  async transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutate(input, 'transfer');
  }

  private async mutate(
    input: OrganizationMembershipMutationInput,
    action: 'change_role' | 'disable' | 'transfer',
    requestedRole?: 'admin' | 'member',
  ): Promise<OrganizationMembershipMutationResult> {
    if (
      input.context.userId !== input.userId ||
      input.context.organizationId !== input.organizationId ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0 ||
      input.username.trim().length === 0 ||
      (action === 'change_role' && requestedRole === undefined)
    ) {
      throw identityStoreError(
        'Identity organization membership input is invalid',
      );
    }

    // The request's own instant, so every event a mutation writes shares one
    // moment and none of them is settled by the database's clock.
    const stamp = auditStamp(input, input.userId, input.context.receivedAt);
    // A refusal is decided inside the transaction that then rolls back, so its
    // record cannot be written there. It is carried out and written after.
    let refused: OrganizationAuditDraft | undefined;

    try {
      return await this.client.transaction(async (transaction) => {
        const organizationRows = await transaction.query(
          LOCK_ORGANIZATION_FOR_MUTATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization)) {
          throw forbidden('Organization membership is required');
        }

        const organizationId = stringValue(organization, 'id');
        const organizationStatus = organizationStatusValue(
          organization,
          'status',
        );
        if (
          organizationId !== input.organizationId ||
          organizationStatus === undefined
        ) {
          throw identityStoreError('Identity data is invalid');
        }
        if (organizationStatus === 'suspended') {
          throw forbidden('Organization is suspended');
        }

        const membershipRows = await transaction.query(
          LOCK_MEMBERSHIPS_FOR_MUTATION_SQL,
          [input.organizationId, input.userId, input.username],
        );
        const lockedMemberships = membershipRows.map((value) => {
          const membership = mapMutationMembershipRow(value);
          if (membership === undefined) {
            throw identityStoreError('Identity data is invalid');
          }
          return membership;
        });
        const caller = lockedMemberships.find(
          (membership) => membership.userId === input.userId,
        );
        if (
          caller === undefined ||
          caller.organizationId !== input.organizationId ||
          caller.userId !== input.userId ||
          caller.status !== 'active'
        ) {
          throw forbidden('Organization membership is required');
        }

        const target = lockedMemberships.find(
          (membership) => membership.username === input.username,
        );
        if (target === undefined) {
          throw notFound();
        }

        const decision = authorizeOrganizationMembershipMutation({
          action,
          callerUserId: caller.userId,
          callerRole: caller.role,
          targetUserId: target.userId,
          targetRole: target.role,
          targetStatus: target.status,
          ...(requestedRole === undefined ? {} : { requestedRole }),
        });
        if (decision.kind === 'forbidden') {
          // Recorded: the caller belongs to this Organization and the target is
          // real, which is exactly the refusal a compliance reader looks for.
          refused = membershipAuditDraft(
            action,
            target,
            caller.username,
            requestedRole,
            'insufficient_authority',
          );
          throw forbidden('Organization membership mutation is not allowed');
        }
        if (decision.kind === 'target_unavailable') {
          throw notFound();
        }
        if (decision.kind === 'invalid') {
          throw invalidMutation();
        }

        // Both repeats that change nothing return early, before the owner
        // count and before any record is written. A retry of an applied state
        // is a delivery, not an act, and these boundaries invite retries.
        if (action === 'disable' && target.status === 'disabled') {
          return mutationResult(target);
        }

        if (action === 'change_role' && target.role === requestedRole) {
          return mutationResult(target);
        }

        if (
          (action === 'disable' && target.role === 'owner') ||
          (action === 'change_role' && target.role === 'owner')
        ) {
          const ownerRows = await transaction.query(COUNT_ACTIVE_OWNERS_SQL, [
            input.organizationId,
          ]);
          const count = ownerCount(ownerRows[0]);
          if (count === undefined) {
            throw identityStoreError('Identity data is invalid');
          }
          if (count <= 1) {
            refused = membershipAuditDraft(
              action,
              target,
              caller.username,
              requestedRole,
              'owner_required',
            );
            throw ownerRequired();
          }
        }

        if (action === 'change_role') {
          const rows = await transaction.query(CHANGE_ROLE_SQL, [
            input.organizationId,
            target.userId,
            requestedRole,
          ]);
          const updated = rows[0];
          const role = isRecord(updated)
            ? membershipRoleValue(updated, 'role')
            : undefined;
          const status = isRecord(updated)
            ? membershipStatusValue(updated, 'membership_status')
            : undefined;
          if (role === undefined || status === undefined) {
            throw identityStoreError('Identity data is invalid');
          }
          await recordOrganizationAuditEvent(
            transaction,
            stamp,
            membershipAuditDraft(action, target, caller.username, role),
          );
          return mutationResult(target, role, status);
        }

        if (action === 'disable') {
          const rows = await transaction.query(DISABLE_MEMBERSHIP_SQL, [
            input.organizationId,
            target.userId,
          ]);
          const updated = rows[0];
          const role = isRecord(updated)
            ? membershipRoleValue(updated, 'role')
            : undefined;
          const status = isRecord(updated)
            ? membershipStatusValue(updated, 'membership_status')
            : undefined;
          if (role === undefined || status !== 'disabled') {
            throw identityStoreError('Identity data is invalid');
          }
          await recordOrganizationAuditEvent(
            transaction,
            stamp,
            membershipAuditDraft(action, target, caller.username, undefined),
          );
          return mutationResult(target, role, status);
        }

        const promotedRows = await transaction.query(
          PROMOTE_TRANSFER_TARGET_SQL,
          [input.organizationId, target.userId],
        );
        const promoted = promotedRows[0];
        const promotedRole = isRecord(promoted)
          ? membershipRoleValue(promoted, 'role')
          : undefined;
        const promotedStatus = isRecord(promoted)
          ? membershipStatusValue(promoted, 'membership_status')
          : undefined;
        if (promotedRole !== 'owner' || promotedStatus !== 'active') {
          throw identityStoreError('Identity data is invalid');
        }

        const demotedRows = await transaction.query(
          DEMOTE_TRANSFER_CALLER_SQL,
          [input.organizationId, caller.userId],
        );
        if (demotedRows.length === 0) {
          throw identityStoreError('Identity data is invalid');
        }

        // One event, not two role changes: ADR-0029 made transfer an atomic
        // command, and splitting it here would invent a self-demotion nobody
        // performed.
        await recordOrganizationAuditEvent(
          transaction,
          stamp,
          membershipAuditDraft(action, target, caller.username, undefined),
        );

        return mutationResult(target, promotedRole, promotedStatus);
      });
    } catch (error) {
      if (refused !== undefined) {
        await recordOrganizationAuditDenial(this.client, stamp, refused);
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}

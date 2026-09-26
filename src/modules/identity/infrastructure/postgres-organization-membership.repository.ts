import { AppError } from '../../../common/errors/app-error';
import type { OrganizationStatus } from '../application/api-key-authenticator.port';
import { ORGANIZATION_READ_ADMISSION } from '../application/organization-admission';
import type {
  ListOrganizationMembersInput,
  ListedOrganizationMember,
  OrganizationMembershipListPort,
  OrganizationMembershipListResult,
} from '../application/organization-membership-list.port';
import { forbidden } from '../application/organization-membership.authorization';
import {
  ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL,
  ORGANIZATION_MEMBERSHIP_TARGET_REFUSAL,
  authorizeOrganizationMembershipMutation,
  hasOrganizationMembershipRouteAuthority,
} from '../application/organization-membership.mutation-policy';
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
    organization.entitlements AS organization_entitlements,
    identity_config.status AS identity_config_status,
    caller.role AS caller_role,
    member_account.username AS member_username,
    member.role AS member_role
  FROM organization_members AS caller
  INNER JOIN organizations AS organization
    ON organization.id = caller.organization_id
  LEFT JOIN organization_identity_configs AS identity_config
    ON identity_config.organization_id = caller.organization_id
  INNER JOIN organization_members AS member
    ON member.organization_id = caller.organization_id
   AND member.status = 'active'
  INNER JOIN user_accounts AS member_account
    ON member_account.id = member.user_account_id
  WHERE caller.user_account_id = $1
    AND caller.status = 'active'
  ORDER BY caller.organization_id ASC, member_account.username ASC
`;

/**
 * A surface's admitted Membership Roles, with the check that one is declared.
 *
 * The roles travel as a query parameter rather than as text spliced into the
 * statement, so the policy can never alter the query's shape. An empty set is
 * refused rather than passed on: a surface that admits no Membership Role is a
 * policy mistake, and it would silently become a read with no authorization.
 */
export function admittedRoles(
  roles: readonly OrganizationMembershipRole[],
): readonly OrganizationMembershipRole[] {
  if (roles.length === 0) {
    throw new Error(
      'organization read admission must admit at least one Membership Role',
    );
  }
  return roles;
}

const MEMBERSHIP_LIST_ADMISSION = ORGANIZATION_READ_ADMISSION.membership_list;

// Authorization stays inside this query because ADR-0051 requires it and the
// rows to come from one point-in-time snapshot. The policy it enforces is read
// from the shared table rather than repeated here.
const LIST_ORGANIZATION_MEMBERS_SQL = `
  SELECT
    authority.allowed AS authorized,
    member_account.username AS member_username,
    membership.role AS member_role,
    membership.status AS member_status
  FROM (
    SELECT EXISTS (
      SELECT 1
      FROM organization_members AS caller
      INNER JOIN organizations AS organization
        ON organization.id = caller.organization_id
      WHERE caller.organization_id = $1
        AND caller.user_account_id = $2
        AND caller.status = 'active'
        AND caller.role = ANY($3::text[])
        ${
          MEMBERSHIP_LIST_ADMISSION.suspensionClosesSurface
            ? "AND organization.status = 'active'"
            : ''
        }
    ) AS allowed
  ) AS authority
  LEFT JOIN organization_members AS membership
    ON authority.allowed
   AND membership.organization_id = $1
   AND membership.status = $4
  LEFT JOIN user_accounts AS member_account
    ON member_account.id = membership.user_account_id
  ORDER BY member_account.username ASC
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
  RETURNING role
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
  readonly organizationEntitlements: readonly string[];
  readonly identityConfigured: boolean;
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

function notFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Resource not found',
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
  const organizationEntitlements = value.organization_entitlements;
  const identityConfigStatus = value.identity_config_status;
  const identityConfigured = identityConfigStatus === 'active';
  const callerRole = membershipRoleValue(value, 'caller_role');
  const memberUsername = stringValue(value, 'member_username');
  const memberRole = membershipRoleValue(value, 'member_role');

  if (
    organizationId === undefined ||
    organizationName === undefined ||
    organizationStatus === undefined ||
    !Array.isArray(organizationEntitlements) ||
    !organizationEntitlements.every(
      (entitlement) =>
        typeof entitlement === 'string' && entitlement.length > 0,
    ) ||
    (identityConfigStatus !== null &&
      identityConfigStatus !== 'active' &&
      identityConfigStatus !== 'disabled') ||
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
    organizationEntitlements,
    identityConfigured,
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
      readonly entitlements: readonly string[];
      readonly identityConfigured: boolean;
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
        entitlements: row.organizationEntitlements,
        identityConfigured: row.identityConfigured,
        membershipRole: row.callerRole,
        members: [{ username: row.memberUsername, role: row.memberRole }],
      });
      continue;
    }

    if (
      existing.name !== row.organizationName ||
      existing.status !== row.organizationStatus ||
      existing.entitlements.length !== row.organizationEntitlements.length ||
      existing.entitlements.some(
        (entitlement, index) =>
          entitlement !== row.organizationEntitlements[index],
      ) ||
      existing.membershipRole !== row.callerRole ||
      existing.identityConfigured !== row.identityConfigured
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

function mapOrganizationMembershipListRows(
  rows: readonly unknown[],
  requestedStatus: OrganizationMembershipStatus,
): OrganizationMembershipListResult {
  if (rows.length === 0) {
    throw identityStoreError('Identity data is invalid');
  }

  const first = rows[0];
  if (!isRecord(first) || typeof first.authorized !== 'boolean') {
    throw identityStoreError('Identity data is invalid');
  }

  const authorized = first.authorized;
  const members: ListedOrganizationMember[] = [];
  let emptyProjectionCount = 0;

  for (const value of rows) {
    if (!isRecord(value) || value.authorized !== authorized) {
      throw identityStoreError('Identity data is invalid');
    }

    if (
      value.member_username === null &&
      value.member_role === null &&
      value.member_status === null
    ) {
      emptyProjectionCount += 1;
      continue;
    }

    const username = stringValue(value, 'member_username');
    const role = membershipRoleValue(value, 'member_role');
    const status = membershipStatusValue(value, 'member_status');
    if (
      username === undefined ||
      role === undefined ||
      status !== requestedStatus
    ) {
      throw identityStoreError('Identity data is invalid');
    }

    members.push({ username, role, status });
  }

  if (
    emptyProjectionCount > 1 ||
    (emptyProjectionCount === 1 && members.length !== 0)
  ) {
    throw identityStoreError('Identity data is invalid');
  }
  if (!authorized) {
    if (rows.length !== 1 || emptyProjectionCount !== 1) {
      throw identityStoreError('Identity data is invalid');
    }
    return { kind: 'denied' };
  }

  return { kind: 'authorized', members };
}

export class PostgresOrganizationMembershipRepository
  implements OrganizationMembershipPort, OrganizationMembershipListPort
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

  async listOrganizationMembers(
    input: ListOrganizationMembersInput,
  ): Promise<OrganizationMembershipListResult> {
    if (
      input.context.userId !== input.userId ||
      input.context.organizationId !== input.organizationId ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0 ||
      (input.status !== 'active' && input.status !== 'disabled')
    ) {
      throw identityStoreError(
        'Identity organization membership input is invalid',
      );
    }

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(LIST_ORGANIZATION_MEMBERS_SQL, [
        input.organizationId,
        input.userId,
        admittedRoles(MEMBERSHIP_LIST_ADMISSION.admittedRoles),
        input.status,
      ]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }

    return mapOrganizationMembershipListRows(rows, input.status);
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

    // Every refusal of a caller outside the route's authority, including
    // one only these locks reveal, carries the route's Safe Authorization
    // Denial.
    const denial = ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL[action];

    try {
      return await this.client.transaction(async (transaction) => {
        const organizationRows = await transaction.query(
          LOCK_ORGANIZATION_FOR_MUTATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization)) {
          throw forbidden(denial);
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
          throw forbidden(denial);
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
          throw forbidden(denial);
        }

        const target = lockedMemberships.find(
          (membership) => membership.username === input.username,
        );
        const decision =
          target &&
          authorizeOrganizationMembershipMutation({
            action,
            callerUserId: caller.userId,
            callerRole: caller.role,
            targetUserId: target.userId,
            targetRole: target.role,
            targetStatus: target.status,
          });
        if (target && decision?.kind === 'forbidden') {
          // Recorded exactly when the target-level policy refuses, as before
          // route authority existed: the caller belongs to this Organization
          // and the target is real, which is the refusal a compliance reader
          // looks for.
          refused = membershipAuditDraft(
            action,
            target,
            caller.username,
            requestedRole,
            'insufficient_authority',
          );
        }

        // Answered before the target's existence can show: a caller without
        // authority on the route gets the same answer for a real username and
        // an unknown one (ADR-0048). `targetIsCaller` is true only when the
        // target was found and is the caller, so a name that resolves to
        // nobody is never the caller's own membership. The application tier
        // cannot answer this: it holds the caller's User Account ID and the
        // target's username, never the target's User Account ID.
        if (
          !hasOrganizationMembershipRouteAuthority({
            action,
            callerRole: caller.role,
            targetIsCaller: target?.userId === caller.userId,
          })
        ) {
          throw forbidden(denial);
        }

        if (!target || !decision) {
          throw notFound();
        }
        if (decision.kind === 'forbidden') {
          throw forbidden(ORGANIZATION_MEMBERSHIP_TARGET_REFUSAL[action]);
        }
        if (decision.kind === 'target_unavailable') {
          throw notFound();
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

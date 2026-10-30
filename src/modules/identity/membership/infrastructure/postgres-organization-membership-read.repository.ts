import { isRecord } from '@/common/is-record';
import type { OrganizationStatus } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { ORGANIZATION_READ_ADMISSION } from '@/modules/identity/membership/application/organization-admission';
import type {
  ListOrganizationMembersInput,
  ListedOrganizationMember,
  OrganizationMembershipListPort,
  OrganizationMembershipListResult,
} from '@/modules/identity/membership/application/organization-membership-list.port';
import type {
  ListRosterInput,
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  OrganizationMembershipResolution,
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
  OrganizationRosterOrganization,
  ResolveMembershipInput,
} from '@/modules/identity/membership/application/organization-membership.port';
import {
  identityStoreError,
  identityStoreUnavailable,
  membershipRoleValue,
  membershipStatusValue,
  organizationStatusValue,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import { isOrganizationContextAllowed } from '@/modules/identity/shared/infrastructure/organization-context-policy';
import {
  type IdentityRepositoryClient,
  identityRows,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

export const RESOLVE_MEMBERSHIP_SQL = `
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

export const LIST_ROSTER_SQL = `
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
export const LIST_ORGANIZATION_MEMBERS_SQL = `
  SELECT
    authority.allowed AS authorized,
    page.member_username,
    page.member_role,
    page.member_status
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
  LEFT JOIN LATERAL (
    SELECT
      member_account.username AS member_username,
      membership.role AS member_role,
      membership.status AS member_status
    FROM organization_members AS membership
    INNER JOIN user_accounts AS member_account
      ON member_account.id = membership.user_account_id
    WHERE authority.allowed
      AND membership.organization_id = $1
      AND membership.status = $4
      AND ($5::text IS NULL OR member_account.username > $5)
    ORDER BY member_account.username ASC
    LIMIT $6
  ) AS page ON true
  ORDER BY page.member_username ASC NULLS LAST
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
export class PostgresOrganizationMembershipReadRepository
  implements
    Pick<OrganizationMembershipPort, 'resolveMembership' | 'listRoster'>,
    OrganizationMembershipListPort
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  async resolveMembership(
    input: ResolveMembershipInput,
  ): Promise<OrganizationMembershipResolution> {
    if (
      input.context.userId !== input.userId ||
      !isOrganizationContextAllowed(input.context, {
        kind: 'optional',
        organizationId: input.organizationId,
      }) ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0
    ) {
      throw identityStoreError(
        'Identity organization membership input is invalid',
      );
    }

    let rows: readonly unknown[];
    try {
      rows = await identityRows(this.client, RESOLVE_MEMBERSHIP_SQL, [
        input.userId,
        input.organizationId,
      ]);
    } catch (error) {
      throw identityStoreUnavailable(error);
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
      rows = await identityRows(this.client, LIST_ROSTER_SQL, [input.userId]);
    } catch (error) {
      throw identityStoreUnavailable(error);
    }

    return groupRosterRows(rows);
  }

  async listOrganizationMembers(
    input: ListOrganizationMembersInput,
  ): Promise<OrganizationMembershipListResult> {
    if (
      input.context.userId !== input.userId ||
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0 ||
      (input.status !== 'active' && input.status !== 'disabled') ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      (input.after !== undefined &&
        (typeof input.after !== 'string' || input.after.trim().length === 0))
    ) {
      throw identityStoreError(
        'Identity organization membership input is invalid',
      );
    }

    let rows: readonly unknown[];
    try {
      rows = await identityRows(this.client, LIST_ORGANIZATION_MEMBERS_SQL, [
        input.organizationId,
        input.userId,
        admittedRoles(MEMBERSHIP_LIST_ADMISSION.admittedRoles),
        input.status,
        input.after ?? null,
        input.limit,
      ]);
    } catch (error) {
      throw identityStoreUnavailable(error);
    }

    return mapOrganizationMembershipListRows(rows, input.status);
  }
}

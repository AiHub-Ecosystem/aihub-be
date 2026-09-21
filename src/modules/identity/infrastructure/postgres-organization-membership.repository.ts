import type { OrganizationStatus } from '../application/api-key-authenticator.port';
import type {
  ListRosterInput,
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  OrganizationMembershipResolution,
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
  OrganizationRosterOrganization,
  ResolveMembershipInput,
} from '../application/organization-membership.port';
import {
  identityStoreError,
  isRecord,
  membershipRoleValue,
  membershipStatusValue,
  organizationStatusValue,
  stringValue,
} from './identity-row';
import type { PostgresIdentityClient } from './postgres-api-key.repository';

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
  constructor(private readonly client: PostgresIdentityClient) {}

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

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}

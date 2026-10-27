import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  auditStamp,
  recordOrganizationAuditDenial,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import type {
  OrganizationAuditDenial,
  OrganizationAuditDraft,
} from '@/modules/identity/domain/organization-audit-event';
import {
  forbidden,
  organizationSuspensionClosesSurface,
} from '@/modules/identity/membership/application/organization-membership.authorization';
import {
  ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL,
  ORGANIZATION_MEMBERSHIP_TARGET_REFUSAL,
  type OrganizationMembershipMutationAction,
  authorizeOrganizationMembershipMutation,
  hasOrganizationMembershipRouteAuthority,
} from '@/modules/identity/membership/application/organization-membership.mutation-policy';
import type {
  OrganizationMembershipMutationInput,
  OrganizationMembershipMutationResult,
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';
import {
  identityStoreError,
  identityStoreUnavailable,
  membershipRoleValue,
  membershipStatusValue,
  organizationStatusValue,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type OrganizationContextPolicy,
  isOrganizationContextAllowed,
} from '@/modules/identity/shared/infrastructure/organization-context-policy';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

type IdentitySqlClient = Parameters<typeof identityRows>[0];

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

export const CHANGE_ROLE_SQL = `
  UPDATE organization_members
  SET role = $3
  WHERE organization_id = $1
    AND user_account_id = $2
    AND status = 'active'
  RETURNING role, status AS membership_status
`;

export const DISABLE_MEMBERSHIP_SQL = `
  UPDATE organization_members
  SET status = 'disabled'
  WHERE organization_id = $1
    AND user_account_id = $2
    AND status = 'active'
  RETURNING role, status AS membership_status
`;

export const PROMOTE_TRANSFER_TARGET_SQL = `
  UPDATE organization_members
  SET role = 'owner'
  WHERE organization_id = $1
    AND user_account_id = $2
    AND status = 'active'
  RETURNING role, status AS membership_status
`;

export const DEMOTE_TRANSFER_CALLER_SQL = `
  UPDATE organization_members
  SET role = 'admin'
  WHERE organization_id = $1
    AND user_account_id = $2
    AND role = 'owner'
    AND status = 'active'
  RETURNING role
`;
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

export function ownerRequired(): AppError {
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

export function mutationResult(
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

export function roleChangedAuditDraft(
  target: MutationMembershipRow,
  toRole: OrganizationMembershipRole,
  denial?: OrganizationAuditDenial,
): OrganizationAuditDraft {
  const refused = denial === undefined ? {} : { denial };
  return {
    action: 'membership.role_changed',
    targetUserAccountId: target.userId,
    username: target.username,
    fromRole: target.role,
    toRole,
    ...refused,
  };
}

export function membershipDisabledAuditDraft(
  target: MutationMembershipRow,
  denial?: OrganizationAuditDenial,
): OrganizationAuditDraft {
  const refused = denial === undefined ? {} : { denial };
  return {
    action: 'membership.disabled',
    targetUserAccountId: target.userId,
    username: target.username,
    role: target.role,
    ...refused,
  };
}

export function ownerTransferredAuditDraft(
  target: MutationMembershipRow,
  previousOwnerUsername: string,
  denial?: OrganizationAuditDenial,
): OrganizationAuditDraft {
  const refused = denial === undefined ? {} : { denial };
  return {
    action: 'membership.owner_transferred',
    targetUserAccountId: target.userId,
    username: target.username,
    fromRole: target.role,
    previousOwnerUsername,
    ...refused,
  };
}

type MembershipMutationDecision =
  | ReturnType<typeof authorizeOrganizationMembershipMutation>
  | undefined;

function validateMutationInput(
  input: OrganizationMembershipMutationInput,
  organizationContextPolicy: OrganizationContextPolicy,
): void {
  if (
    input.context.userId !== input.userId ||
    !isOrganizationContextAllowed(input.context, organizationContextPolicy) ||
    input.userId.trim().length === 0 ||
    input.organizationId.trim().length === 0 ||
    input.username.trim().length === 0
  ) {
    throw identityStoreError(
      'Identity organization membership input is invalid',
    );
  }
}

export async function lockMutationContext(
  transaction: IdentitySqlClient,
  input: OrganizationMembershipMutationInput,
  routeDenial: string,
): Promise<{
  readonly caller: MutationMembershipRow;
  readonly target: MutationMembershipRow | undefined;
}> {
  const organizationRows = await identityRows(
    transaction,
    LOCK_ORGANIZATION_FOR_MUTATION_SQL,
    [input.organizationId],
  );
  const organization = organizationRows[0];
  if (!isRecord(organization)) throw forbidden(routeDenial);

  const organizationId = stringValue(organization, 'id');
  const organizationStatus = organizationStatusValue(organization, 'status');
  if (
    organizationId !== input.organizationId ||
    organizationStatus === undefined
  ) {
    throw identityStoreError('Identity data is invalid');
  }
  if (organizationSuspensionClosesSurface(organizationStatus)) {
    throw forbidden(routeDenial);
  }

  const membershipRows = await identityRows(
    transaction,
    LOCK_MEMBERSHIPS_FOR_MUTATION_SQL,
    [input.organizationId, input.userId, input.username],
  );
  const memberships = membershipRows.map((value) => {
    const membership = mapMutationMembershipRow(value);
    if (membership === undefined) {
      throw identityStoreError('Identity data is invalid');
    }
    return membership;
  });
  const caller = memberships.find(
    (membership) => membership.userId === input.userId,
  );
  if (
    caller === undefined ||
    caller.organizationId !== input.organizationId ||
    caller.userId !== input.userId ||
    caller.status !== 'active'
  ) {
    throw forbidden(routeDenial);
  }

  return {
    caller,
    target: memberships.find(
      (membership) => membership.username === input.username,
    ),
  };
}

export function mutationDecision(
  action: OrganizationMembershipMutationAction,
  caller: MutationMembershipRow,
  target: MutationMembershipRow | undefined,
): MembershipMutationDecision {
  if (target === undefined) return undefined;
  return authorizeOrganizationMembershipMutation({
    action,
    callerUserId: caller.userId,
    callerRole: caller.role,
    targetUserId: target.userId,
    targetRole: target.role,
    targetStatus: target.status,
  });
}

export function requireAuthorizedMutationTarget(
  action: OrganizationMembershipMutationAction,
  caller: MutationMembershipRow,
  target: MutationMembershipRow | undefined,
  decision: MembershipMutationDecision,
): MutationMembershipRow {
  // The caller captures a real target refusal before this route denial wins.
  if (
    !hasOrganizationMembershipRouteAuthority({
      action,
      callerRole: caller.role,
      targetIsCaller: target?.userId === caller.userId,
    })
  ) {
    throw forbidden(ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL[action]);
  }
  if (target === undefined || decision === undefined) {
    throw notFound();
  }
  if (decision.kind === 'forbidden') {
    throw forbidden(ORGANIZATION_MEMBERSHIP_TARGET_REFUSAL[action]);
  }
  if (decision.kind === 'target_unavailable') {
    throw notFound();
  }
  return target;
}

export async function isLastActiveOwner(
  transaction: IdentitySqlClient,
  organizationId: string,
): Promise<boolean> {
  const ownerRows = await identityRows(transaction, COUNT_ACTIVE_OWNERS_SQL, [
    organizationId,
  ]);
  const count = ownerCount(ownerRows[0]);
  if (count === undefined) {
    throw identityStoreError('Identity data is invalid');
  }
  return count <= 1;
}

export function mapUpdatedMembership(value: unknown): {
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
} {
  const role = isRecord(value) ? membershipRoleValue(value, 'role') : undefined;
  const status = isRecord(value)
    ? membershipStatusValue(value, 'membership_status')
    : undefined;
  if (role === undefined || status === undefined) {
    throw identityStoreError('Identity data is invalid');
  }
  return { role, status };
}

async function rethrowMutationFailure(
  client: IdentityRepositoryClient,
  stamp: ReturnType<typeof auditStamp>,
  refused: OrganizationAuditDraft | undefined,
  error: unknown,
): Promise<never> {
  // Denial audit follows rollback; a write failure cannot replace the refusal.
  if (refused !== undefined) {
    await recordOrganizationAuditDenial(client, stamp, refused);
  }
  if (error instanceof AppError) throw error;
  throw identityStoreUnavailable(error);
}

export function prepareMembershipMutation(
  client: IdentityRepositoryClient,
  input: OrganizationMembershipMutationInput,
  organizationContextPolicy: OrganizationContextPolicy,
): {
  readonly stamp: ReturnType<typeof auditStamp>;
  readonly refuse: (draft: OrganizationAuditDraft) => void;
  readonly rethrow: (error: unknown) => Promise<never>;
} {
  validateMutationInput(input, organizationContextPolicy);
  const stamp = auditStamp(input, input.userId, input.context.receivedAt);
  let refused: OrganizationAuditDraft | undefined;

  return {
    stamp,
    refuse: (draft) => {
      refused = draft;
    },
    rethrow: (error) => rethrowMutationFailure(client, stamp, refused, error),
  };
}

interface AuthorizedMutation {
  readonly transaction: IdentitySqlClient;
  readonly caller: MutationMembershipRow;
  readonly target: MutationMembershipRow;
  readonly stamp: ReturnType<typeof auditStamp>;
  readonly refuse: (draft: OrganizationAuditDraft) => void;
}

/**
 * The skeleton every Membership mutation shares: validate, open the
 * transaction, lock the Organization and Memberships, decide, record the
 * refusal audit a forbidden target earns, and refuse in the one order the
 * route promises. `run` receives an authorized target and does the write.
 */
export async function runAuthorizedMutation(
  client: IdentityRepositoryClient,
  input: OrganizationMembershipMutationInput,
  action: OrganizationMembershipMutationAction,
  forbiddenDraft: (
    target: MutationMembershipRow,
    caller: MutationMembershipRow,
  ) => OrganizationAuditDraft,
  run: (
    context: AuthorizedMutation,
  ) => Promise<OrganizationMembershipMutationResult>,
): Promise<OrganizationMembershipMutationResult> {
  const mutation = prepareMembershipMutation(client, input, {
    kind: 'required',
    organizationId: input.organizationId,
  });
  try {
    return await identityTransaction(client, async (transaction) => {
      const { caller, target } = await lockMutationContext(
        transaction,
        input,
        ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL[action],
      );
      const decision = mutationDecision(action, caller, target);
      if (target !== undefined && decision?.kind === 'forbidden') {
        mutation.refuse(forbiddenDraft(target, caller));
      }
      const authorizedTarget = requireAuthorizedMutationTarget(
        action,
        caller,
        target,
        decision,
      );
      return run({
        transaction,
        caller,
        target: authorizedTarget,
        stamp: mutation.stamp,
        refuse: mutation.refuse,
      });
    });
  } catch (error) {
    return mutation.rethrow(error);
  }
}

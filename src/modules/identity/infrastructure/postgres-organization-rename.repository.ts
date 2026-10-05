import { AppError } from '@/common/errors/app-error';
import type {
  OrganizationRenameRecordPort,
  RenameOrganizationRecordInput,
  RenameOrganizationRecordResult,
} from '@/modules/identity/application/organization-rename-record.port';
import type { OrganizationAuditDraft } from '@/modules/identity/domain/organization-audit-event';

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
import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';

// Organization first, then membership: the order every membership mutation
// takes, so a rename and a concurrent owner transfer queue rather than deadlock.
const LOCK_ORGANIZATION_SQL = `
  SELECT id, name, status
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

const LOCK_CALLER_MEMBERSHIP_SQL = `
  SELECT role, status
  FROM organization_members
  WHERE organization_id = $1
    AND user_account_id = $2
  FOR UPDATE
`;

const RENAME_ORGANIZATION_SQL = `
  UPDATE organizations
  SET name = $2
  WHERE id = $1
`;

/**
 * Authority is decided here, under the locks, rather than before the
 * transaction: an owner demoted by a transfer that commits first must find
 * themselves an admin when this one proceeds (ADR-0043).
 */
export class PostgresOrganizationRenameRepository
  implements OrganizationRenameRecordPort
{
  constructor(private readonly client: PostgresIdentityTransactionalClient) {}

  async renameOrganization(
    input: RenameOrganizationRecordInput,
  ): Promise<RenameOrganizationRecordResult> {
    const stamp = auditStamp(input, input.userId, input.context.receivedAt);
    let refused: OrganizationAuditDraft | undefined;

    try {
      const result = await this.client.transaction(async (transaction) => {
        const organizationRows = await transaction.query(
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization)) {
          return { kind: 'forbidden' as const };
        }
        const currentName = stringValue(organization, 'name');
        const status = organizationStatusValue(organization, 'status');
        if (currentName === undefined || status === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        const membershipRows = await transaction.query(
          LOCK_CALLER_MEMBERSHIP_SQL,
          [input.organizationId, input.userId],
        );
        const membership = membershipRows[0];
        if (!isRecord(membership)) {
          return { kind: 'forbidden' as const };
        }
        const role = membershipRoleValue(membership, 'role');
        const membershipStatus = membershipStatusValue(membership, 'status');
        if (role === undefined || membershipStatus === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        // Neither refusal is recorded: a disabled caller no longer belongs,
        // and suspension closes the surface for every role alike.
        if (membershipStatus !== 'active' || status === 'suspended') {
          return { kind: 'forbidden' as const };
        }
        if (role !== 'owner') {
          refused = {
            action: 'organization.renamed',
            organizationId: input.organizationId,
            name: currentName,
            denial: 'insufficient_authority',
          };
          return { kind: 'forbidden' as const };
        }

        // A repeat of the current name is a delivery, not an act.
        if (currentName === input.name) {
          return {
            kind: 'unchanged' as const,
            organizationId: input.organizationId,
            name: currentName,
          };
        }

        await transaction.query(RENAME_ORGANIZATION_SQL, [
          input.organizationId,
          input.name,
        ]);
        await recordOrganizationAuditEvent(transaction, stamp, {
          action: 'organization.renamed',
          organizationId: input.organizationId,
          name: input.name,
          previousName: currentName,
        });

        return {
          kind: 'renamed' as const,
          organizationId: input.organizationId,
          name: input.name,
        };
      });

      if (refused !== undefined) {
        await recordOrganizationAuditDenial(this.client, stamp, refused);
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }
}

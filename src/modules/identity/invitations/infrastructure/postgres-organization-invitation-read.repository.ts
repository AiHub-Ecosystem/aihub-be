import { AppError } from '@/common/errors/app-error';
import type {
  ListOpenOrganizationInvitationsInput,
  OpenOrganizationInvitationRecord,
  OpenOrganizationInvitationRecordPort,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import {
  identityStoreUnavailable,
  invalidIdentityData,
} from '@/modules/identity/shared/infrastructure/identity-row';
import { isOrganizationContextAllowed } from '@/modules/identity/shared/infrastructure/organization-context-policy';
import type { IdentityRepositoryClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { mapOpenOrganizationInvitation } from './map-open-organization-invitation';
import { invalidInvitationInput } from './organization-invitation-input';

/** Lists the open invitations of one Organization. */
export class PostgresOrganizationInvitationReadRepository
  implements OpenOrganizationInvitationRecordPort
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  async listOpenInvitations(
    input: ListOpenOrganizationInvitationsInput,
  ): Promise<readonly OpenOrganizationInvitationRecord[]> {
    if (
      input.context.userId !== input.userId ||
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0 ||
      !(input.now instanceof Date) ||
      Number.isNaN(input.now.getTime()) ||
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit <= 0 ||
      (input.after !== undefined &&
        (!(input.after.createdAt instanceof Date) ||
          Number.isNaN(input.after.createdAt.getTime()) ||
          typeof input.after.id !== 'string' ||
          input.after.id.trim().length === 0))
    ) {
      throw invalidInvitationInput();
    }

    // The issuer is read through the relation, so a broken identity projection
    // fails the whole list rather than silently dropping an actionable
    // invitation. `consumedAt` is the durable close signal for consumed,
    // superseded, and revoked invitations; expiry is evaluated against the
    // application clock. Keyset pagination orders by createdAt desc, id asc.
    try {
      const open = await this.client.organizationInvitation.findMany({
        where: {
          organizationId: input.organizationId,
          consumedAt: null,
          expiresAt: { gt: input.now },
          ...(input.after !== undefined
            ? {
                OR: [
                  { createdAt: { lt: input.after.createdAt } },
                  {
                    createdAt: input.after.createdAt,
                    id: { gt: input.after.id },
                  },
                ],
              }
            : {}),
        },
        take: input.limit,
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
          expiresAt: true,
          invitedByUser: { select: { username: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return open.map(({ invitedByUser, ...invitation }) => {
        const item = mapOpenOrganizationInvitation({
          ...invitation,
          invitedByUsername: invitedByUser.username,
        });
        if (item === undefined) {
          throw invalidIdentityData();
        }
        return item;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw identityStoreUnavailable(error);
    }
  }
}

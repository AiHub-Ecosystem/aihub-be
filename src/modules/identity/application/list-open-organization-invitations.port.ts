import type {
  ListOpenOrganizationInvitationsCommand,
  ListedOrganizationInvitation,
} from './list-open-organization-invitations';

export interface ListOpenOrganizationInvitationsPort {
  list(
    input: ListOpenOrganizationInvitationsCommand,
  ): Promise<readonly ListedOrganizationInvitation[]>;
}

export const LIST_OPEN_ORGANIZATION_INVITATIONS = Symbol(
  'LIST_OPEN_ORGANIZATION_INVITATIONS',
);

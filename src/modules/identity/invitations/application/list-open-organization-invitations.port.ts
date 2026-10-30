import type {
  ListOpenOrganizationInvitationsCommand,
  OpenOrganizationInvitationPage,
} from './list-open-organization-invitations';

export interface ListOpenOrganizationInvitationsPort {
  list(
    input: ListOpenOrganizationInvitationsCommand,
  ): Promise<OpenOrganizationInvitationPage>;
}

export const LIST_OPEN_ORGANIZATION_INVITATIONS = Symbol(
  'LIST_OPEN_ORGANIZATION_INVITATIONS',
);

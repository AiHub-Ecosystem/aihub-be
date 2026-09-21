import type {
  AcceptOrganizationInvitationCommand,
  AcceptedOrganizationInvitation,
} from './accept-organization-invitation';

export interface AcceptOrganizationInvitationPort {
  accept(
    command: AcceptOrganizationInvitationCommand,
  ): Promise<AcceptedOrganizationInvitation>;
}

export const ACCEPT_ORGANIZATION_INVITATION = Symbol(
  'ACCEPT_ORGANIZATION_INVITATION',
);

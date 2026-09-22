import type { RevokeOrganizationInvitationCommand } from './revoke-organization-invitation';

export interface RevokeOrganizationInvitationPort {
  revoke(input: RevokeOrganizationInvitationCommand): Promise<void>;
}

export const REVOKE_ORGANIZATION_INVITATION = Symbol(
  'REVOKE_ORGANIZATION_INVITATION',
);

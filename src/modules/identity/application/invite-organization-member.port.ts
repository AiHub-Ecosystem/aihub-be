import type {
  InviteOrganizationMemberInput,
  InvitedOrganizationMember,
} from './invite-organization-member';

export interface InviteOrganizationMemberPort {
  invite(
    input: InviteOrganizationMemberInput,
  ): Promise<InvitedOrganizationMember>;
}

export const INVITE_ORGANIZATION_MEMBER = Symbol('INVITE_ORGANIZATION_MEMBER');

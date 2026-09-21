export interface IssuedOrganizationInviteToken {
  readonly id: string;
  readonly raw: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

export interface OrganizationInviteTokenPort {
  issue(now: Date): IssuedOrganizationInviteToken;
  hash(raw: string): string;
}

export const ORGANIZATION_INVITE_TOKEN = Symbol('ORGANIZATION_INVITE_TOKEN');

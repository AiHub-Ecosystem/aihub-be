import type { OpenOrganizationInvitationRecord } from '@/modules/identity/invitations/application/organization-invitation.port';
import {
  dateValue,
  isRecord,
  membershipRoleValue,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';

/**
 * Projects one invitation row for the open-invitation view. A malformed row
 * or issuer projection answers `undefined`, so the whole view fails rather
 * than dropping one invitation (ADR-0031).
 */
export function mapOpenOrganizationInvitation(
  value: unknown,
): OpenOrganizationInvitationRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const invitationId = stringValue(value, 'id');
  const email = stringValue(value, 'email');
  const role = membershipRoleValue(value, 'role');
  const invitedByUsername = stringValue(value, 'invitedByUsername');
  const createdAt = dateValue(value, 'createdAt');
  const expiresAt = dateValue(value, 'expiresAt');

  if (
    invitationId === undefined ||
    email === undefined ||
    role === undefined ||
    invitedByUsername === undefined ||
    createdAt == null ||
    expiresAt == null
  ) {
    return undefined;
  }

  return {
    invitationId,
    email,
    role,
    invitedByUsername,
    createdAt,
    expiresAt,
  };
}

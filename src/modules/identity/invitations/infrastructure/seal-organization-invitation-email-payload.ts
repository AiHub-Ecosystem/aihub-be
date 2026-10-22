import type { EmailPayloadCipherPort } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { CreateOrganizationInvitationInput } from '@/modules/identity/invitations/application/organization-invitation.port';

export function sealOrganizationInvitationEmailPayload(
  cipher: EmailPayloadCipherPort,
  input: CreateOrganizationInvitationInput,
  organizationName: string,
  inviterUsername: string,
): string {
  return cipher.encrypt(
    JSON.stringify({
      email: input.email,
      organizationName,
      role: input.role,
      token: input.emailDelivery.token,
      expiresAt: input.expiresAt.toISOString(),
      inviterUsername,
    }),
  );
}

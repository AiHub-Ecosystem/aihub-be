import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import type {
  AcceptOrganizationInvitationInput,
  AcceptOrganizationInvitationResult,
  CreateOrganizationInvitationInput,
  CreateOrganizationInvitationResult,
  ListOpenOrganizationInvitationsInput,
  OpenOrganizationInvitationRecord,
  OrganizationInvitationPort,
  RevokeOrganizationInvitationInput,
  RevokeOrganizationInvitationResult,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import type { IdentityRepositoryClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { PostgresOrganizationInvitationAcceptRepository } from './postgres-organization-invitation-accept.repository';
import { PostgresOrganizationInvitationCreateRepository } from './postgres-organization-invitation-create.repository';
import { PostgresOrganizationInvitationReadRepository } from './postgres-organization-invitation-read.repository';
import { PostgresOrganizationInvitationRevokeRepository } from './postgres-organization-invitation-revoke.repository';

/**
 * Binds the four Organization Invitation operations to the one driven port.
 * Each operation keeps its own locks, audit writes, and Email Outbox handoff in
 * its own repository; this class only delegates.
 */
export class PostgresOrganizationInvitationRepository
  implements OrganizationInvitationPort
{
  private readonly creates: PostgresOrganizationInvitationCreateRepository;
  private readonly reads: PostgresOrganizationInvitationReadRepository;
  private readonly revokes: PostgresOrganizationInvitationRevokeRepository;
  private readonly accepts: PostgresOrganizationInvitationAcceptRepository;

  constructor(client: IdentityRepositoryClient, emailOutbox: EmailOutboxPort) {
    this.creates = new PostgresOrganizationInvitationCreateRepository(
      client,
      emailOutbox,
    );
    this.reads = new PostgresOrganizationInvitationReadRepository(client);
    this.revokes = new PostgresOrganizationInvitationRevokeRepository(client);
    this.accepts = new PostgresOrganizationInvitationAcceptRepository(client);
  }

  createInvitation(
    input: CreateOrganizationInvitationInput,
  ): Promise<CreateOrganizationInvitationResult> {
    return this.creates.createInvitation(input);
  }

  listOpenInvitations(
    input: ListOpenOrganizationInvitationsInput,
  ): Promise<readonly OpenOrganizationInvitationRecord[]> {
    return this.reads.listOpenInvitations(input);
  }

  revokeInvitation(
    input: RevokeOrganizationInvitationInput,
  ): Promise<RevokeOrganizationInvitationResult> {
    return this.revokes.revokeInvitation(input);
  }

  acceptInvitation(
    input: AcceptOrganizationInvitationInput,
  ): Promise<AcceptOrganizationInvitationResult> {
    return this.accepts.acceptInvitation(input);
  }
}

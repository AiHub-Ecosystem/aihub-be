import { ulid } from 'ulid';

import type {
  AttachFirstOwnerResult,
  OrganizationFirstOwnerPort,
} from '../modules/identity/application/organization-first-owner.port';
import { createPostgresIdentityClient } from '../modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationFirstOwnerRepository } from '../modules/identity/infrastructure/postgres-organization-first-owner.repository';

export interface AttachFirstOwnerCliInput {
  readonly databaseUrl: string;
  readonly organizationId: string;
  readonly ownerUsername: string;
  readonly actorUsername: string;
  readonly repository?: OrganizationFirstOwnerPort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type AttachFirstOwnerCliOutcome = AttachFirstOwnerResult['kind'];

/**
 * First Owner Attachment as an operator (ADR-0045). Every outcome is named, so
 * the operator knows which input to fix; the caller decides the exit status.
 */
export async function runAttachFirstOwnerCommand(
  input: AttachFirstOwnerCliInput,
): Promise<AttachFirstOwnerCliOutcome> {
  const emit = input.emit ?? console.log;
  const now = input.now ?? (() => new Date());
  const requestId = `req_${ulid()}`;
  const repository =
    input.repository ??
    new PostgresOrganizationFirstOwnerRepository(
      createPostgresIdentityClient(input.databaseUrl),
    );

  let result: AttachFirstOwnerResult;
  try {
    result = await repository.attachFirstOwner({
      organizationId: input.organizationId,
      ownerUsername: input.ownerUsername,
      actorUsername: input.actorUsername,
      requestId,
      occurredAt: now(),
    });
  } finally {
    await repository.close();
  }

  const messages: Record<AttachFirstOwnerCliOutcome, string> = {
    attached: `Attached ${input.ownerUsername} as owner of ${input.organizationId}; recorded as ${requestId}.`,
    unchanged: `${input.ownerUsername} is already the owner of ${input.organizationId}; nothing was recorded.`,
    organization_not_found: `Organization ${input.organizationId} was not found.`,
    owner_invalid: `${input.ownerUsername} is not an AIHUB User Account that can be attached.`,
    actor_invalid: `${input.actorUsername} is not an active AIHUB User Account.`,
    actor_is_owner: `${input.actorUsername} cannot attach their own account; another operator must run this.`,
    organization_has_members: `${input.organizationId} already has an active member; use an invitation instead.`,
  };
  emit(messages[result.kind]);

  return result.kind;
}

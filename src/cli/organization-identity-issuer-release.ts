import type { OrganizationIdentityIssuerReleasePort } from '@/modules/identity/organization-identity-configuration/application/organization-identity-issuer-release.port';
import { PostgresOrganizationIdentityIssuerReleaseRepository } from '@/modules/identity/organization-identity-configuration/infrastructure/postgres-organization-identity-issuer-release.repository';
import { runOperatorCommand } from './operator-command-context';
import { createOperatorIdentityClient } from './operator-identity-client';

export interface OrganizationIdentityIssuerReleaseCliInput {
  readonly databaseUrl: string;
  readonly organizationId: string;
  readonly actorUsername: string;
  readonly repository?: OrganizationIdentityIssuerReleasePort & {
    close(): Promise<void>;
  };
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type OrganizationIdentityIssuerReleaseCliOutcome =
  | 'released'
  | 'organization_not_found'
  | 'actor_invalid'
  | 'issuer_unclaimed';

export async function runReleaseOrganizationIdentityIssuerCommand(
  input: OrganizationIdentityIssuerReleaseCliInput,
): Promise<OrganizationIdentityIssuerReleaseCliOutcome> {
  const emit = input.emit ?? console.log;
  const repository =
    input.repository ??
    new PostgresOrganizationIdentityIssuerReleaseRepository(
      await createOperatorIdentityClient(input.databaseUrl),
    );
  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ requestId, occurredAt }) =>
      repository.releaseIssuer({
        organizationId: input.organizationId,
        actorUsername: input.actorUsername,
        requestId,
        occurredAt,
      }),
  );
  if (result.kind === 'organization_not_found') {
    emit(`Organization ${input.organizationId} was not found.`);
  } else if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
  } else if (result.kind === 'issuer_unclaimed') {
    emit(
      `Organization ${input.organizationId} has no claimed identity issuer.`,
    );
  } else {
    emit(`Released the identity issuer for ${input.organizationId}.`);
  }
  return result.kind;
}

import { ulid } from 'ulid';

import type {
  CreateOrganizationResult,
  OrganizationCreatePort,
} from '@/modules/identity/organizations/application/organization-create.port';
import { PostgresOrganizationCreateRepository } from '@/modules/identity/organizations/infrastructure/postgres-organization-create.repository';
import { runOperatorCommand } from './operator-command-context';
import { createOperatorIdentityClient } from './operator-identity-client';

export interface CreateOrganizationCliInput {
  readonly databaseUrl: string;
  readonly organizationId?: string;
  readonly name: string;
  readonly entitlements?: readonly string[];
  readonly rateLimitRpm?: number;
  readonly maxConcurrent?: number;
  readonly monthlyRequestQuota?: number | null;
  readonly hardStopOnQuota?: boolean;
  readonly repository?: OrganizationCreatePort;
  /** Captured by callers such as demo-bootstrap to get the created org id */
  readonly print?: (line: string) => void;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type CreateOrganizationCliOutcome = CreateOrganizationResult['kind'];

/**
 * Creates an Organization as an operator.
 * Operator-provisioned organizations start ownerless (ADR-0045) and write no
 * audit event (ADR-0044).
 */
export async function runCreateOrganizationCommand(
  input: CreateOrganizationCliInput,
): Promise<CreateOrganizationCliOutcome> {
  const print = input.print ?? console.log;
  const repository =
    input.repository ??
    new PostgresOrganizationCreateRepository(
      await createOperatorIdentityClient(input.databaseUrl),
    );
  const organizationId = input.organizationId ?? `org_${ulid()}`;
  const execution = await runOperatorCommand(repository, input.now, () =>
    repository.createOrganization({
      id: organizationId,
      name: input.name,
      entitlements: input.entitlements ?? ['writing'],
      rateLimitRpm: input.rateLimitRpm ?? 600,
      maxConcurrent: input.maxConcurrent ?? 20,
      monthlyRequestQuota: input.monthlyRequestQuota ?? null,
      hardStopOnQuota: input.hardStopOnQuota ?? false,
    }),
  );
  print(execution.result.id);
  return execution.result.kind;
}

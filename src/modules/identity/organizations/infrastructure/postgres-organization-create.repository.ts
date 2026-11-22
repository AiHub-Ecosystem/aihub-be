import { AppError } from '@/common/errors/app-error';
import type {
  CreateOrganizationInput,
  CreateOrganizationResult,
  OrganizationCreatePort,
} from '@/modules/identity/organizations/application/organization-create.port';
import { identityStoreUnavailable } from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

export class PostgresOrganizationCreateRepository
  implements OrganizationCreatePort
{
  constructor(
    private readonly client: IdentityRepositoryClient & {
      close(): Promise<void>;
    },
  ) {}

  async createOrganization(
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResult> {
    try {
      return await identityTransaction(
        this.client,
        input.id,
        async (transaction) => {
          await transaction.organization.create({
            data: {
              id: input.id,
              name: input.name,
              status: 'active',
              entitlements: [...input.entitlements],
              rateLimitRpm: input.rateLimitRpm,
              maxConcurrent: input.maxConcurrent,
              monthlyRequestQuota: input.monthlyRequestQuota,
              hardStopOnQuota: input.hardStopOnQuota,
            },
          });
          return { kind: 'created', id: input.id };
        },
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreUnavailable(error);
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

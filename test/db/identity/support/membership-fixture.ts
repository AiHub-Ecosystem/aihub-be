import { ulid } from 'ulid';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';

import { AppModule } from '@/app.module';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import {
  NO_USER_ACCESS_TOKEN_REVOCATIONS,
  verifiedUserAccessToken,
} from '@/modules/auth/testing/user-access-token-verifier.stub';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import { USER_ACCESS_TOKEN_REVOCATION_RECORD } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { ORGANIZATION_MEMBERSHIP } from '@/modules/identity/membership/application/organization-membership.port';
import { PostgresOrganizationMembershipRepository } from '@/modules/identity/membership/infrastructure/postgres-organization-membership.repository';
import { createPostgresIdentityClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../../shared/database';
import { PausingIdentityClient } from '../../shared/pausing-identity-client';

export {
  type QueryPause,
  waitForQueryCapture,
} from '../../shared/pausing-identity-client';
export { waitForBlockedBy } from '../../shared/database';

export const REQUEST_ID = 'req_01J00000000000000000000000';

export function bearer(userId: string): string {
  return `Bearer ${userId}.token.value`;
}

export interface MembershipFixtureOptions {
  /** The primary Organization for list/mutation suites; roster seeds its own. */
  readonly primaryOrganization?: {
    readonly id: string;
    readonly name: string;
  };
  readonly now?: Date;
}

/** The shared DB-lane arrangement for the Membership list, mutation and roster suites. */
export class MembershipFixture {
  app!: NestFastifyApplication;
  pool!: Pool;
  identityClient!: PausingIdentityClient;
  private readonly now: Date;

  constructor(private readonly options: MembershipFixtureOptions) {
    this.now = options.now ?? new Date('2026-09-24T12:00:00.000Z');
  }

  async boot(): Promise<void> {
    this.pool = createTestPool();
    this.identityClient = new PausingIdentityClient(
      createPostgresIdentityClient(testDatabaseUrl()),
    );
    const membership = new PostgresOrganizationMembershipRepository(
      this.identityClient.asPrisma(),
    );
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token) =>
        verifiedUserAccessToken(token.split('.')[0] ?? '', 'jti_01'),
    };
    const userAccounts = userAccountStatus(async (userId) => {
      const result = await this.pool.query<{ status: 'active' | 'disabled' }>(
        'SELECT status FROM user_accounts WHERE id = $1',
        [userId],
      );
      return result.rows[0]?.status;
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccounts)
      .overrideProvider(USER_ACCESS_TOKEN_REVOCATION_RECORD)
      .useValue(NO_USER_ACCESS_TOKEN_REVOCATIONS)
      .compile();

    this.app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => REQUEST_ID }),
    );
    await this.app.init();
    await this.app.getHttpAdapter().getInstance().ready();
  }

  async close(): Promise<void> {
    await this.app.close();
    await this.pool.end();
  }

  async reset(): Promise<void> {
    await resetIdentityTables(this.pool);
  }

  async seedOrganization(
    id: string,
    status: 'active' | 'suspended' = 'active',
    name = `Name of ${id}`,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)',
      [id, name, status],
    );
  }

  async reseedPrimaryOrganization(): Promise<void> {
    const primary = this.options.primaryOrganization;
    if (primary === undefined) {
      throw new Error('this suite has no primary Organization to reseed');
    }
    await this.reset();
    await this.seedOrganization(primary.id, 'active', primary.name);
  }

  async seedAccount(
    username: string,
    status: 'active' | 'disabled' = 'active',
  ): Promise<string> {
    const id = `usr_${ulid()}`;
    await this.pool.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [id, username, status, this.now],
    );
    return id;
  }

  async seedMembership(
    userAccountId: string,
    role: 'owner' | 'admin' | 'member',
    status: 'active' | 'disabled',
    organizationId?: string,
  ): Promise<void> {
    const target = organizationId ?? this.options.primaryOrganization?.id;
    if (target === undefined) {
      throw new Error('a membership needs an Organization id');
    }
    await this.pool.query(
      `INSERT INTO organization_members (
         organization_id, user_account_id, role, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $5)`,
      [target, userAccountId, role, status, this.now],
    );
  }
}

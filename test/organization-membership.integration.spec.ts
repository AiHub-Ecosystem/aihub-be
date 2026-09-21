import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../src/modules/auth/application/local-auth-repository.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '../src/modules/auth/application/user-access-token.port';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
} from '../src/modules/identity/application/organization-membership.port';
import type { PostgresIdentityClient } from '../src/modules/identity/infrastructure/postgres-api-key.repository';
import type { PostgresIdentityTransactionalClient } from '../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationMembershipRepository } from '../src/modules/identity/infrastructure/postgres-organization-membership.repository';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const MUTATION_URL = `/v1/organizations/${ORGANIZATION_ID}/members/bob`;

const callerOwnerRow = {
  organization_id: ORGANIZATION_ID,
  user_account_id: USER_ID,
  username: 'alice',
  role: 'owner',
  membership_status: 'active',
};

const targetMemberRow = {
  organization_id: ORGANIZATION_ID,
  user_account_id: 'usr_bob',
  username: 'bob',
  role: 'member',
  membership_status: 'active',
};

const targetAdminResultRow = {
  organization_id: ORGANIZATION_ID,
  user_account_id: 'usr_bob',
  username: 'bob',
  role: 'admin',
  membership_status: 'active',
};

class FakePostgres
  implements PostgresIdentityClient, PostgresIdentityTransactionalClient
{
  readonly transactionQueries: Array<{
    readonly text: string;
    readonly values: readonly unknown[];
  }> = [];

  readonly result: readonly unknown[] = [
    {
      organization_id: ORGANIZATION_ID,
      user_account_id: USER_ID,
      organization_status: 'active',
      role: 'owner',
      membership_status: 'active',
    },
  ];

  readonly transactionRows: readonly (readonly unknown[])[] = [
    [{ id: ORGANIZATION_ID, status: 'active' }],
    [callerOwnerRow, targetMemberRow],
    [targetAdminResultRow],
  ];

  query(
    _text: string,
    _values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    return Promise.resolve(this.result);
  }

  transaction<T>(
    callback: Parameters<PostgresIdentityTransactionalClient['transaction']>[0],
  ): Promise<T> {
    let index = 0;
    return callback({
      query: async (text, values) => {
        this.transactionQueries.push({ text, values });
        return this.transactionRows[index++] ?? [];
      },
    }) as Promise<T>;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Organization membership HTTP/application/repository integration', () => {
  let app: NestFastifyApplication;
  let client: FakePostgres;

  beforeAll(async () => {
    client = new FakePostgres();
    const membership: OrganizationMembershipPort =
      new PostgresOrganizationMembershipRepository(client);
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        if (token !== 'valid.token.value') {
          throw new Error('invalid token');
        }
        return { userId: USER_ID, jti: 'jti_01' };
      },
    };
    const localAuthRepository: Pick<
      LocalAuthRepositoryPort,
      'findUserAccountStatus'
    > = {
      findUserAccountStatus: async () => 'active',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(LOCAL_AUTH_REPOSITORY)
      .useValue(localAuthRepository)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => 'req_01J00000000000000000000000' }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('wires a Bearer role mutation through the application and repository ports', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: MUTATION_URL,
      headers: { authorization: 'Bearer valid.token.value' },
      payload: { role: 'admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        organization_id: ORGANIZATION_ID,
        username: 'bob',
        role: 'admin',
        status: 'active',
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    });
    expect(client.transactionQueries[0]?.text).toContain('FROM organizations');
    expect(client.transactionQueries[0]?.text).toContain('FOR UPDATE');
    expect(client.transactionQueries[1]?.text).toContain(
      'FOR UPDATE OF membership',
    );
    expect(client.transactionQueries.at(-1)?.text).toContain(
      'UPDATE organization_members',
    );
  });
});

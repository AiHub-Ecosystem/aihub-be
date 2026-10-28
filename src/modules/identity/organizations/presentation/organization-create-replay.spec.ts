import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyExecutionInput,
  type IdempotencyReplayDecoder,
  type IdempotencyServicePort,
  type IdempotencyWork,
} from '@/modules/idempotency/application/idempotency-service.port';
import {
  CREATE_ORGANIZATION,
  type CreateOrganizationPort,
} from '@/modules/identity/organizations/application/create-organization.port';

const USER_ID = 'usr_01J00000000000000000000000';
const REQUEST_ID = 'req_01J00000000000000000000000';

const storedOrganization = {
  organizationId: 'org_acme',
  name: 'Acme',
  status: 'active',
  role: 'owner',
};

describe('Organization create replay', () => {
  let app: NestFastifyApplication;
  let create: jest.Mocked<CreateOrganizationPort>;
  let idempotency: jest.Mocked<IdempotencyServicePort>;

  beforeAll(async () => {
    create = { create: jest.fn() };
    idempotency = {
      execute: jest.fn(),
    } as jest.Mocked<IdempotencyServicePort>;
    const verifier: UserAccessTokenVerifierPort = {
      verify: async () => ({ userId: USER_ID, jti: 'jti_01' }),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CREATE_ORGANIZATION)
      .useValue(create)
      .overrideProvider(IDEMPOTENCY_SERVICE)
      .useValue(idempotency)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccountStatus())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => REQUEST_ID }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function replayStored(stored: unknown): void {
    idempotency.execute.mockImplementationOnce(
      async (
        _input: IdempotencyExecutionInput,
        _work: IdempotencyWork<unknown>,
        decodeReplay: IdempotencyReplayDecoder<unknown>,
      ) => ({ result: decodeReplay(stored), replay: true }),
    );
  }

  function post() {
    return app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: {
        authorization: 'Bearer valid.token.value',
        'idempotency-key': 'create-1',
      },
      payload: { name: 'Acme' },
    });
  }

  it('replays a stored body that carries members a newer release added', async () => {
    replayStored({ ...storedOrganization, plan: 'team' });

    const response = await post();

    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotent-replay']).toBe('true');
    expect(response.json<unknown>()).toEqual({
      data: {
        organization: {
          organization_id: 'org_acme',
          name: 'Acme',
          status: 'active',
        },
        role: 'owner',
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(create.create.mock.calls).toHaveLength(0);
  });

  it('still refuses a stored body whose role this release cannot report', async () => {
    replayStored({ ...storedOrganization, role: 'billing_admin' });

    const response = await post();

    expect(response.statusCode).toBe(500);
    expect(create.create.mock.calls).toHaveLength(0);
  });
});

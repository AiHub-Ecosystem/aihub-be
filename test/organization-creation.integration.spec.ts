import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  type CompleteIdempotencyInput,
  IDEMPOTENCY_REPOSITORY,
  type IdempotencyAttemptInput,
  type IdempotencyRepositoryPort,
  type IdempotencyReservation,
  type ReserveIdempotencyInput,
} from '@/modules/idempotency/application/idempotency-repository.port';
import {
  type CreateOrganizationRecordInput,
  type CreateOrganizationRecordResult,
  ORGANIZATION_CREATION,
  type OrganizationCreationPort,
} from '@/modules/identity/application/organization-creation.port';

const OWNER_TOKEN = 'owner.token.value';
const OTHER_TOKEN = 'other.token.value';
const OWNER_ID = 'usr_01J00000000000000000000001';
const OTHER_ID = 'usr_01J00000000000000000000002';
const DISABLED_TOKEN = 'disabled.token.value';
const DISABLED_ID = 'usr_01J00000000000000000000003';
const REQUEST_ID = 'req_01J00000000000000000000000';

/** Stands in for the durable act the database lane covers; it keeps only the limit. */
class OrganizationCreationFake implements OrganizationCreationPort {
  readonly created: CreateOrganizationRecordInput[] = [];

  async createOrganization(
    input: CreateOrganizationRecordInput,
  ): Promise<CreateOrganizationRecordResult> {
    const byCreator = this.created.filter(
      (record) => record.creatorUserId === input.creatorUserId,
    );
    if (byCreator.length >= input.creationLimit) {
      return { kind: 'limit_reached' };
    }
    this.created.push(input);
    return { kind: 'created', organizationId: `org_${this.created.length}` };
  }
}

class IdempotencyRepositoryFake implements IdempotencyRepositoryPort {
  private readonly records = new Map<
    string,
    {
      fingerprintHex: string;
      requestId: string;
      completed?: { status: number; body: unknown };
    }
  >();

  clear(): void {
    this.records.clear();
  }

  async reserve(
    input: ReserveIdempotencyInput,
  ): Promise<IdempotencyReservation> {
    const existing = this.records.get(this.key(input));
    if (existing === undefined) {
      this.records.set(this.key(input), {
        fingerprintHex: input.fingerprintHex,
        requestId: input.requestId,
      });
      return { kind: 'claimed', requestId: input.requestId };
    }
    if (existing.fingerprintHex !== input.fingerprintHex) {
      return { kind: 'conflict', reason: 'fingerprint' };
    }
    if (existing.completed === undefined) {
      return { kind: 'conflict', reason: 'pending' };
    }
    return {
      kind: 'replay',
      responseStatus: existing.completed.status,
      responseBody: JSON.parse(JSON.stringify(existing.completed.body)),
    };
  }

  async complete(input: CompleteIdempotencyInput): Promise<void> {
    const existing = this.records.get(this.key(input));
    if (existing !== undefined) {
      existing.completed = {
        status: input.responseStatus,
        body: input.responseBody,
      };
    }
  }

  async markFailed(input: IdempotencyAttemptInput): Promise<void> {
    this.records.delete(this.key(input));
  }

  async delete(input: IdempotencyAttemptInput): Promise<void> {
    this.records.delete(this.key(input));
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }

  private key(input: IdempotencyAttemptInput): string {
    return [
      input.organizationId ?? '',
      input.operation,
      input.actorScope ?? '',
      input.idempotencyKey,
    ].join(':');
  }
}

describe('Self-serve Organization creation over HTTP', () => {
  let app: NestFastifyApplication;
  let creation: OrganizationCreationFake;
  let idempotency: IdempotencyRepositoryFake;

  beforeAll(async () => {
    creation = new OrganizationCreationFake();
    idempotency = new IdempotencyRepositoryFake();
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        if (token === OWNER_TOKEN) {
          return { userId: OWNER_ID, jti: 'jti_owner' };
        }
        if (token === OTHER_TOKEN) {
          return { userId: OTHER_ID, jti: 'jti_other' };
        }
        if (token === DISABLED_TOKEN) {
          return { userId: DISABLED_ID, jti: 'jti_disabled' };
        }
        throw new Error('invalid token');
      },
    };
    const userAccounts = userAccountStatus((userId) =>
      userId === DISABLED_ID ? 'disabled' : 'active',
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_CREATION)
      .useValue(creation)
      .overrideProvider(IDEMPOTENCY_REPOSITORY)
      .useValue(idempotency)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccounts)
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

  beforeEach(() => {
    creation.created.length = 0;
    idempotency.clear();
  });

  function create(
    payload: unknown,
    options: { readonly token?: string; readonly key?: string } = {},
  ) {
    const token = options.token ?? OWNER_TOKEN;
    return app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.key === undefined
          ? {}
          : { 'idempotency-key': options.key }),
      },
      payload: payload as Record<string, unknown>,
    });
  }

  it('creates an Organization from a trimmed name and names the caller its owner', async () => {
    const response = await create({ name: '  Acme Learning  ' });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: {
        organization: {
          organization_id: 'org_1',
          name: 'Acme Learning',
          status: 'active',
        },
        role: 'owner',
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(creation.created).toHaveLength(1);
    expect(creation.created[0]).toMatchObject({
      creatorUserId: OWNER_ID,
      name: 'Acme Learning',
      creationLimit: 3,
      terms: {
        entitlements: ['writing', 'speaking'],
        rateLimitRpm: 60,
        maxConcurrent: 5,
        monthlyRequestQuota: 100,
        hardStopOnQuota: true,
      },
    });
  });

  it.each([
    ['an entitlement', { name: 'Acme', entitlements: ['speaking'] }],
    ['a rate limit', { name: 'Acme', rate_limit_rpm: 10_000 }],
    ['a monthly quota', { name: 'Acme', monthly_request_quota: null }],
    ['a hard stop', { name: 'Acme', hard_stop_on_quota: false }],
    ['a blank name', { name: '   ' }],
    ['an oversized name', { name: 'a'.repeat(101) }],
    ['no name', {}],
  ])(
    'rejects a request carrying %s without creating anything',
    async (_, body) => {
      const response = await create(body);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(creation.created).toHaveLength(0);
    },
  );

  it('refuses a creation past the Organization Creation Limit with a distinct conflict', async () => {
    for (const name of ['One', 'Two', 'Three']) {
      expect((await create({ name })).statusCode).toBe(201);
    }

    const response = await create({ name: 'Four' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      'ORGANIZATION_CREATION_LIMIT_REACHED',
    );
    expect(creation.created).toHaveLength(3);
  });

  it('replays a keyed creation instead of creating a second Organization, even at the limit', async () => {
    const first = await create({ name: 'Acme' }, { key: 'create-1' });
    await create({ name: 'Two' });
    await create({ name: 'Three' });

    const replay = await create({ name: 'Acme' }, { key: 'create-1' });

    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().data).toEqual(first.json().data);
    expect(creation.created).toHaveLength(3);
  });

  it('never shares replay state between accounts using the same key', async () => {
    const owner = await create({ name: 'Acme' }, { key: 'shared' });
    const other = await create(
      { name: 'Acme' },
      { key: 'shared', token: OTHER_TOKEN },
    );

    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replay']).toBeUndefined();
    expect(other.json().data.organization.organization_id).not.toBe(
      owner.json().data.organization.organization_id,
    );
  });

  it('gives a disabled account the standard Bearer denial', async () => {
    const response = await create({ name: 'Acme' }, { token: DISABLED_TOKEN });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_USER_ACCESS_TOKEN_INVALID');
    expect(creation.created).toHaveLength(0);
  });

  it('requires a Bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      payload: { name: 'Acme' },
    });

    expect(response.statusCode).toBe(401);
    expect(creation.created).toHaveLength(0);
  });
});

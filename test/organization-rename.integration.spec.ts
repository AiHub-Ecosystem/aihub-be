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
  ORGANIZATION_RENAME,
  type OrganizationRenamePort,
  type RenameOrganizationRecordInput,
  type RenameOrganizationRecordResult,
} from '../src/modules/identity/application/organization-rename.port';

const OWNER_TOKEN = 'owner.token.value';
const ADMIN_TOKEN = 'admin.token.value';
const OUTSIDER_TOKEN = 'outsider.token.value';
const OWNER_ID = 'usr_01J00000000000000000000001';
const ADMIN_ID = 'usr_01J00000000000000000000002';
const OUTSIDER_ID = 'usr_01J00000000000000000000003';
const ORGANIZATION_ID = 'org_01J00000000000000000000009';
const REQUEST_ID = 'req_01J00000000000000000000000';

/**
 * Stands in for the durable act the database lane covers, where the authority
 * matrix is decided under locks. Here it only answers the three outcomes the
 * boundary must translate.
 */
class OrganizationRenameFake implements OrganizationRenamePort {
  readonly calls: RenameOrganizationRecordInput[] = [];
  name = 'Acme';

  async renameOrganization(
    input: RenameOrganizationRecordInput,
  ): Promise<RenameOrganizationRecordResult> {
    this.calls.push(input);
    if (input.userId !== OWNER_ID || input.organizationId !== ORGANIZATION_ID) {
      return { kind: 'forbidden' };
    }
    if (input.name === this.name) {
      return {
        kind: 'unchanged',
        organizationId: ORGANIZATION_ID,
        name: this.name,
      };
    }
    this.name = input.name;
    return {
      kind: 'renamed',
      organizationId: ORGANIZATION_ID,
      name: this.name,
    };
  }
}

describe('Organization rename over HTTP', () => {
  let app: NestFastifyApplication;
  let rename: OrganizationRenameFake;

  beforeAll(async () => {
    rename = new OrganizationRenameFake();
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        const userId = {
          [OWNER_TOKEN]: OWNER_ID,
          [ADMIN_TOKEN]: ADMIN_ID,
          [OUTSIDER_TOKEN]: OUTSIDER_ID,
        }[token];
        if (userId === undefined) {
          throw new Error('invalid token');
        }
        return { userId, jti: `jti_${userId}` };
      },
    };
    const localAuthRepository: Pick<
      LocalAuthRepositoryPort,
      'findUserAccountStatus'
    > = { findUserAccountStatus: async () => 'active' };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_RENAME)
      .useValue(rename)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(LOCAL_AUTH_REPOSITORY)
      .useValue(localAuthRepository)
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
    rename.calls.length = 0;
    rename.name = 'Acme';
  });

  function patch(
    payload: unknown,
    options: { readonly token?: string; readonly organizationId?: string } = {},
  ) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${options.organizationId ?? ORGANIZATION_ID}`,
      headers: { authorization: `Bearer ${options.token ?? OWNER_TOKEN}` },
      payload: payload as Record<string, unknown>,
    });
  }

  it('renames the Organization to the trimmed name and returns it', async () => {
    const response = await patch({ name: '  Acme Learning  ' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        organization: {
          organization_id: ORGANIZATION_ID,
          name: 'Acme Learning',
          status: 'active',
        },
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(rename.calls).toHaveLength(1);
    expect(rename.calls[0]).toMatchObject({
      userId: OWNER_ID,
      organizationId: ORGANIZATION_ID,
      name: 'Acme Learning',
    });
  });

  it('answers a rename to the current name with the same success', async () => {
    const response = await patch({ name: 'Acme' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.organization.name).toBe('Acme');
  });

  it('treats a change of case as a rename', async () => {
    const response = await patch({ name: 'ACME' });

    expect(response.statusCode).toBe(200);
    expect(rename.name).toBe('ACME');
  });

  it.each([
    ['an entitlement', { name: 'Acme', entitlements: ['speaking'] }],
    ['a rate limit', { name: 'Acme', rate_limit_rpm: 10_000 }],
    ['a concurrency ceiling', { name: 'Acme', max_concurrent: 100 }],
    ['a monthly quota', { name: 'Acme', monthly_request_quota: null }],
    ['a hard stop', { name: 'Acme', hard_stop_on_quota: false }],
    ['a status', { name: 'Acme', status: 'active' }],
    ['a blank name', { name: '   ' }],
    ['an empty name', { name: '' }],
    ['an oversized name', { name: 'a'.repeat(101) }],
    ['no name', {}],
  ])(
    'rejects a request carrying %s without touching the Organization',
    async (_, body) => {
      const response = await patch(body);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(rename.calls).toHaveLength(0);
    },
  );

  it('accepts a name of exactly 100 characters after trimming', async () => {
    const response = await patch({ name: ` ${'a'.repeat(100)} ` });

    expect(response.statusCode).toBe(200);
  });

  it('gives an admin and an outsider one indistinguishable denial', async () => {
    const admin = await patch({ name: 'Mine now' }, { token: ADMIN_TOKEN });
    const outsider = await patch(
      { name: 'Mine now' },
      { token: OUTSIDER_TOKEN },
    );

    expect(admin.statusCode).toBe(403);
    expect(admin.json()).toEqual(outsider.json());
    expect(admin.json().error.code).toBe('FORBIDDEN');
    expect(rename.name).toBe('Acme');
  });

  it('ignores an Idempotency-Key rather than replaying through it', async () => {
    const send = (name: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${ORGANIZATION_ID}`,
        headers: {
          authorization: `Bearer ${OWNER_TOKEN}`,
          'idempotency-key': 'rename-1',
        },
        payload: { name },
      });

    const first = await send('Acme Learning');
    const second = await send('Acme Academy');

    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(second.json().data.organization.name).toBe('Acme Academy');
    expect(rename.calls).toHaveLength(2);
  });

  it('requires a Bearer token', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${ORGANIZATION_ID}`,
      payload: { name: 'Acme Learning' },
    });

    expect(response.statusCode).toBe(401);
    expect(rename.calls).toHaveLength(0);
  });
});

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { LightMyRequestResponse } from 'fastify';
import { exportPKCS8 } from 'jose';
import { ulid } from 'ulid';

import { AppModule } from '@/app.module';
import { registerRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import {
  type RuntimeConnectionConfiguration,
  appConfig,
} from '@/config/runtime-configuration';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { generateApiKey } from '@/modules/identity/domain/api-key';
import { RUNTIME_CONNECTION_CONFIGURATION } from '@/modules/secrets/application/runtime-connection-configuration.port';
import {
  createSandboxTestPool,
  createSandboxTestRedis,
  createTestPool,
  sandboxTestDatabaseUrl,
  sandboxTestRedisUrl,
  testDatabaseUrl,
} from './database';
import {
  createTenantIdentity,
  signUserAssertion,
} from './tenant-isolation/fixtures';

const ORGANIZATION_ID = 'org_sandbox_customer';
const DEMO_ORGANIZATION_ID = 'org_sandbox_demo_config_test';
const ASSERTION_ISSUER = 'https://identity.customer.test';
const GRADE_PATH = '/v1/ielts/writing/task1/grade';
const TASK2_PATH = '/v1/ielts/writing/task2/grade';
const GRADE_REQUEST_FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test/fixtures/ai-writing/grade-task1.request.json'),
    'utf8',
  ),
) as {
  question: string;
  topic: string;
  essay: string;
  url: string;
};
const GRADE_INPUT = {
  question: GRADE_REQUEST_FIXTURE.question,
  chart_type: GRADE_REQUEST_FIXTURE.topic,
  essay: GRADE_REQUEST_FIXTURE.essay,
  image_url: GRADE_REQUEST_FIXTURE.url,
};
const GRADE_RESPONSE: unknown = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test/fixtures/ai-writing/grade-task1.response.json'),
    'utf8',
  ),
);
const TASK2_REQUEST_FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test/fixtures/ai-writing/grade-task2.request.json'),
    'utf8',
  ),
) as { question: string; topic: string; essay: string };
const TASK2_INPUT = {
  question: TASK2_REQUEST_FIXTURE.question,
  topic: TASK2_REQUEST_FIXTURE.topic,
  essay: TASK2_REQUEST_FIXTURE.essay,
};
const TASK2_RESPONSE: unknown = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test/fixtures/ai-writing/grade-task2.response.json'),
    'utf8',
  ),
);
const SPEAKING_RESPONSE: unknown = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test/fixtures/ai-speaking/grading.response.json'),
    'utf8',
  ),
);

function redisQuotaKey(): string {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `aihub:v1:quota:${ORGANIZATION_ID}:${month}`;
}

let controlPlane: ReturnType<typeof createTestPool>;
let sandbox: ReturnType<typeof createSandboxTestPool>;
let redis: ReturnType<typeof createSandboxTestRedis>;
let app: NestFastifyApplication;
let controlPlaneApp: NestFastifyApplication;
type MutableAppConfiguration = {
  -readonly [Key in keyof ReturnType<typeof appConfig>]: ReturnType<
    typeof appConfig
  >[Key];
};
type MutableConnectionConfiguration = {
  -readonly [Key in keyof RuntimeConnectionConfiguration]: RuntimeConnectionConfiguration[Key];
};
let appConfiguration: MutableAppConfiguration;
let controlPlaneConfiguration: MutableAppConfiguration;
let appConnectionConfiguration: MutableConnectionConfiguration;
let controlPlaneConnectionConfiguration: MutableConnectionConfiguration;
let apiKey: {
  readonly id: string;
  readonly raw: string;
  readonly hash: string;
};
let apiKeyCreation: LightMyRequestResponse;
let signedAssertion: string;
let downstreamCalls: number;
let controlPlaneReaderRole: string;
let ownerUserId: string;
let adminUserId: string;
let memberUserId: string;

beforeAll(async () => {
  controlPlane = createTestPool();
  sandbox = createSandboxTestPool();
  redis = createSandboxTestRedis();
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      redis.once('ready', resolve);
      redis.once('error', reject);
    });
  }
  await redis.flushdb();
  await sandbox.query(
    `TRUNCATE organization_audit_events, organization_identity_configs,
       api_keys, organization_invitations, organization_members,
       auth_identities, user_accounts, idempotency_records, dispatch_attempts,
       usage_records,
       sandbox_dispatch_reservations, organizations CASCADE`,
  );
  await controlPlane.query(
    `TRUNCATE organization_audit_events, organization_identity_configs,
      api_keys, organization_invitations, organization_members,
      auth_identities, user_accounts, organizations CASCADE`,
  );

  controlPlaneReaderRole = `sandbox_reader_${ulid().toLowerCase()}`;
  const controlPlaneReaderPassword = randomBytes(24).toString('hex');
  await controlPlane.query(
    `CREATE ROLE ${controlPlaneReaderRole} LOGIN PASSWORD '${controlPlaneReaderPassword}'`,
  );
  const controlPlaneDatabaseName = new URL(testDatabaseUrl()).pathname.slice(1);
  await controlPlane.query(
    `GRANT CONNECT ON DATABASE "${controlPlaneDatabaseName}" TO ${controlPlaneReaderRole}`,
  );
  await controlPlane.query(
    `GRANT USAGE ON SCHEMA public TO ${controlPlaneReaderRole}`,
  );
  await controlPlane.query(
    `GRANT SELECT (id, status, entitlements, rate_limit_rpm, max_concurrent,
       monthly_request_quota, hard_stop_on_quota)
     ON organizations TO ${controlPlaneReaderRole}`,
  );
  await controlPlane.query(
    `GRANT SELECT (id, organization_id, key_hash, status, scopes,
       allowed_environments, expires_at, last_used_at),
       UPDATE (last_used_at) ON api_keys TO ${controlPlaneReaderRole}`,
  );
  await controlPlane.query(
    `GRANT SELECT (organization_id, issuer, jwks_url, public_keys_jwks,
       allowed_algorithms, max_assertion_ttl_seconds, status,
       jwks_cache_version)
     ON organization_identity_configs TO ${controlPlaneReaderRole}`,
  );
  const controlPlaneReaderUrl = new URL(testDatabaseUrl());
  controlPlaneReaderUrl.username = controlPlaneReaderRole;
  controlPlaneReaderUrl.password = controlPlaneReaderPassword;
  const identity = await createTenantIdentity(
    ASSERTION_ISSUER,
    'customer-sandbox-key',
  );
  signedAssertion = await signUserAssertion(identity, new Date());

  await controlPlane.query(
    `INSERT INTO organizations
       (id, name, entitlements, rate_limit_rpm, max_concurrent,
        monthly_request_quota, hard_stop_on_quota)
     VALUES ($1, 'Sandbox customer', ARRAY['writing'], 600, 20, 0, true)`,
    [ORGANIZATION_ID],
  );
  await controlPlane.query(
    `INSERT INTO organization_identity_configs
       (organization_id, issuer, jwks_url, public_keys_jwks,
        allowed_algorithms, max_assertion_ttl_seconds, status)
     VALUES ($1, $2, NULL, $3::jsonb, ARRAY['RS256'], 300, 'active')`,
    [ORGANIZATION_ID, identity.issuer, JSON.stringify(identity.jwks)],
  );

  for (const role of ['owner', 'admin', 'member'] as const) {
    const id = `usr_${ulid()}`;
    if (role === 'owner') ownerUserId = id;
    if (role === 'admin') adminUserId = id;
    if (role === 'member') memberUserId = id;
    const username = `s-${id.slice(-16).toLowerCase()}`;
    await controlPlane.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [id, username],
    );
    await controlPlane.query(
      `INSERT INTO organization_members
         (organization_id, user_account_id, role, status)
       VALUES ($1, $2, $3, 'active')`,
      [ORGANIZATION_ID, id, role],
    );
  }

  controlPlaneConfiguration = createAppConfiguration();
  controlPlaneConnectionConfiguration = createConnectionConfiguration(
    testDatabaseUrl(),
    controlPlaneReaderUrl.toString(),
  );
  const verifier: UserAccessTokenVerifierPort = {
    verify: async (token) => ({
      userId: token.split('.')[0] ?? '',
      jti: 'test-jti',
    }),
  };
  const userAccounts = userAccountStatus(async (userId) => {
    const result = await controlPlane.query<{ status: 'active' | 'disabled' }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [userId],
    );
    return result.rows[0]?.status;
  });
  const controlPlaneModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(appConfig.KEY)
    .useValue(controlPlaneConfiguration)
    .overrideProvider(RUNTIME_CONNECTION_CONFIGURATION)
    .useValue(controlPlaneConnectionConfiguration)
    .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
    .useValue(verifier)
    .overrideProvider(USER_ACCOUNT_REPOSITORY)
    .useValue(userAccounts)
    .compile();
  controlPlaneApp =
    controlPlaneModule.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
  await controlPlaneApp.init();
  await controlPlaneApp.getHttpAdapter().getInstance().ready();

  apiKeyCreation = await createSandboxKey(ownerUserId);
  if (apiKeyCreation.statusCode !== 201) {
    throw new Error(
      `Sandbox API-key creation returned ${apiKeyCreation.statusCode}`,
    );
  }
  const createdKey = apiKeyCreation.json().data as {
    id: string;
    api_key: string;
  };
  apiKey = {
    id: createdKey.id,
    raw: createdKey.api_key,
    hash: createHash('sha256').update(createdKey.api_key).digest('hex'),
  };

  appConfiguration = createAppConfiguration();
  appConnectionConfiguration = createConnectionConfiguration(
    sandboxTestDatabaseUrl(),
    controlPlaneReaderUrl.toString(),
  );

  downstreamCalls = 0;
  const downstreamStub = {
    async request(request: { readonly path: string }) {
      downstreamCalls += 1;
      return {
        status: 200,
        headers: {},
        body: request.path.includes('/speaking/')
          ? SPEAKING_RESPONSE
          : request.path.includes('task2')
            ? TASK2_RESPONSE
            : GRADE_RESPONSE,
      };
    },
    async close() {},
  } as unknown as DownstreamHttpClient;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(appConfig.KEY)
    .useValue(appConfiguration)
    .overrideProvider(RUNTIME_CONNECTION_CONFIGURATION)
    .useValue(appConnectionConfiguration)
    .overrideProvider(DownstreamHttpClient)
    .useValue(downstreamStub)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: () => generateRequestId() }),
  );
  const fastify = app.getHttpAdapter().getInstance();
  registerRequestLifecycle(fastify);
  await app.init();
  await fastify.ready();
});

function createAppConfiguration(): MutableAppConfiguration {
  return {
    ...appConfig(),
    NODE_ENV: 'test',
    AIHUB_PRODUCTION_HOST: 'api.production.test',
    AIHUB_STAGING_HOST: 'api.staging.test',
    AIHUB_DEVELOPMENT_HOST: 'api.development.test',
    AIHUB_SANDBOX_HOST: 'api.sandbox.test',
    AIHUB_SANDBOX_ORG_IDS: undefined,
  };
}

function createConnectionConfiguration(
  databaseUrl: string,
  controlPlaneReadDatabaseUrl: string,
): MutableConnectionConfiguration {
  return {
    databaseUrl,
    controlPlaneDatabaseUrl: testDatabaseUrl(),
    controlPlaneReadDatabaseUrl,
    redisUrl: sandboxTestRedisUrl(),
    sandboxAssertionPrivateKey: undefined,
    sandboxAssertionKeyId: undefined,
  };
}

beforeEach(async () => {
  downstreamCalls = 0;
  await redis.flushdb();
  await sandbox.query(
    'TRUNCATE sandbox_dispatch_reservations, idempotency_records, dispatch_attempts, usage_records',
  );
  await controlPlane.query(
    "UPDATE organizations SET status = 'active' WHERE id = $1",
    [ORGANIZATION_ID],
  );
  await controlPlane.query('UPDATE api_keys SET status = $1 WHERE id = $2', [
    'active',
    apiKey.id,
  ]);
});

afterAll(async () => {
  await app?.close();
  await controlPlaneApp?.close();
  await redis?.quit().catch(() => undefined);
  if (controlPlaneReaderRole !== undefined) {
    await controlPlane
      ?.query(`DROP OWNED BY ${controlPlaneReaderRole}`)
      .catch(() => undefined);
    await controlPlane
      ?.query(`DROP ROLE IF EXISTS ${controlPlaneReaderRole}`)
      .catch(() => undefined);
  }
  await controlPlane?.end().catch(() => undefined);
  await sandbox?.end().catch(() => undefined);
});

async function requestGrade(
  path: string,
  payload: Record<string, string>,
  idempotencyKey: string,
  host = 'api.sandbox.test',
  userIdentity = signedAssertion,
): Promise<LightMyRequestResponse> {
  return await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: path,
      headers: {
        host,
        'content-type': 'application/json',
        'x-api-key': apiKey.raw,
        'x-user-identity': userIdentity,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
}

function createSandboxKey(
  userId: string,
  name = 'Sandbox integration',
): Promise<LightMyRequestResponse> {
  return controlPlaneApp
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/v1/organizations/${ORGANIZATION_ID}/api-keys`,
      headers: { authorization: `Bearer ${userId}.test.token` },
      payload: {
        name,
        scopes: ['writing.grade'],
        allowed_environments: ['sandbox'],
      },
    });
}

function grade(
  idempotencyKey: string,
  host = 'api.sandbox.test',
): Promise<LightMyRequestResponse> {
  return requestGrade(GRADE_PATH, GRADE_INPUT, idempotencyKey, host);
}

describe('Customer Sandbox over Nest/Fastify, Postgres, and Redis', () => {
  it('keeps the migrated demo key usable for assertion minting and Speaking', async () => {
    const demoOrganizationId = DEMO_ORGANIZATION_ID;
    const demoKey = generateApiKey(`ak_sandbox_demo_${ulid().toLowerCase()}`);
    const demoIdentity = await createTenantIdentity(
      'https://demo.identity.test',
      'demo-sandbox-http',
    );
    const demoPrivateKey = await exportPKCS8(demoIdentity.privateKey);
    const savedConfiguration = {
      organizations: appConfiguration.AIHUB_SANDBOX_ORG_IDS,
      privateKey: appConnectionConfiguration.sandboxAssertionPrivateKey,
      keyId: appConnectionConfiguration.sandboxAssertionKeyId,
    };

    // The demo Organization, its key, and its identity configuration live in
    // the production control plane (ADR-0056), so the fixture seeds them
    // directly there rather than reproducing a cutover.
    await controlPlane.query(
      `INSERT INTO organizations
         (id, name, entitlements, rate_limit_rpm, max_concurrent,
          monthly_request_quota, hard_stop_on_quota)
       VALUES ($1, 'Demo Sandbox', ARRAY['speaking'], 60, 3, 10, true)`,
      [demoOrganizationId],
    );
    await controlPlane.query(
      `INSERT INTO api_keys
         (id, organization_id, key_hash, key_prefix, name, scopes,
          allowed_environments, status)
       VALUES ($1, $2, decode($3, 'hex'), $4, 'BFF demo key',
         ARRAY['speaking.grade'], ARRAY['sandbox'], 'active')`,
      [demoKey.id, demoOrganizationId, demoKey.hash, demoKey.prefix],
    );
    await controlPlane.query(
      `INSERT INTO organization_identity_configs
         (organization_id, issuer, jwks_url, public_keys_jwks,
          allowed_algorithms, max_assertion_ttl_seconds, status)
       VALUES ($1, $2, NULL, $3::jsonb,
         ARRAY['RS256'], 300, 'active')`,
      [
        demoOrganizationId,
        demoIdentity.issuer,
        JSON.stringify(demoIdentity.jwks),
      ],
    );

    try {
      appConfiguration.AIHUB_SANDBOX_ORG_IDS = demoOrganizationId;
      appConnectionConfiguration.sandboxAssertionPrivateKey = demoPrivateKey;
      appConnectionConfiguration.sandboxAssertionKeyId = demoIdentity.keyId;
      const minted = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/sandbox/assertions',
          headers: {
            host: 'api.sandbox.test',
            'content-type': 'application/json',
            'x-api-key': demoKey.raw,
          },
          payload: { user_id: 'demo-user-123' },
        });
      expect(minted.statusCode).toBe(200);
      const mintedAssertion = minted.json<{
        data: { assertion: string; user_id: string };
      }>().data.assertion;
      expect(minted.json()).toMatchObject({
        data: { user_id: 'demo-user-123' },
      });
      const speaking = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/ielts/speaking/grading-json',
          headers: {
            host: 'api.sandbox.test',
            'content-type': 'application/json',
            'x-api-key': demoKey.raw,
            'x-user-identity': mintedAssertion,
          },
          payload: {
            audio_url: 'https://s3.wispace.app/audio/demo.mp3',
            part: 1,
            question_id: 'p1_hometown',
          },
        });

      expect(speaking.statusCode).toBe(200);
      expect(speaking.json().meta.operation).toBe('speaking.grading-json');
      expect(downstreamCalls).toBe(1);
    } finally {
      appConfiguration.AIHUB_SANDBOX_ORG_IDS = savedConfiguration.organizations;
      appConnectionConfiguration.sandboxAssertionPrivateKey =
        savedConfiguration.privateKey;
      appConnectionConfiguration.sandboxAssertionKeyId =
        savedConfiguration.keyId;
      await controlPlane.query(
        'DELETE FROM api_keys WHERE organization_id = $1',
        [demoOrganizationId],
      );
      await controlPlane.query(
        'DELETE FROM organization_identity_configs WHERE organization_id = $1',
        [demoOrganizationId],
      );
      await controlPlane.query('DELETE FROM organizations WHERE id = $1', [
        demoOrganizationId,
      ]);
    }
  });

  it('creates an owner Sandbox key over HTTP and persists only its hash', async () => {
    expect(apiKeyCreation.statusCode).toBe(201);
    expect(apiKeyCreation.headers['cache-control']).toBe('no-store');
    expect(apiKeyCreation.json()).toMatchObject({
      data: {
        id: apiKey.id,
        allowed_environments: ['sandbox'],
        scopes: ['writing.grade'],
      },
    });
    expect(apiKeyCreation.json().data.api_key).toBe(apiKey.raw);

    const stored = await controlPlane.query<{
      key_hash: string;
      scopes: string[];
      allowed_environments: string[];
    }>(
      `SELECT encode(key_hash, 'hex') AS key_hash, scopes, allowed_environments
       FROM api_keys WHERE id = $1`,
      [apiKey.id],
    );
    expect(stored.rows).toEqual([
      {
        key_hash: apiKey.hash,
        scopes: ['writing.grade'],
        allowed_environments: ['sandbox'],
      },
    ]);
  });

  it('allows an Organization admin to create a Sandbox-only Writing key', async () => {
    const response = await createSandboxKey(adminUserId, 'Admin Sandbox key');

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      scopes: ['writing.grade'],
      allowed_environments: ['sandbox'],
    });
  });

  it('denies an ordinary Organization member Sandbox key creation', async () => {
    const response = await createSandboxKey(memberUserId, 'Member Sandbox key');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  });

  it('reads control-plane identity while writing usage, idempotency, and dispatch budget only to Sandbox', async () => {
    const response = await grade('sandbox-http-success-1');
    if (response.statusCode !== 200) {
      throw new Error(
        `Unexpected HTTP ${response.statusCode}: ${response.body}`,
      );
    }

    expect(response.statusCode).toBe(200);
    expect(downstreamCalls).toBe(1);
    await expect(
      controlPlane.query(
        'SELECT count(*)::int AS count FROM organizations WHERE id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM organizations WHERE id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      sandbox.query(
        `SELECT environment, billable_requests FROM usage_records
         WHERE organization_id = $1`,
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({
      rows: [{ environment: 'sandbox', billable_requests: 1 }],
    });
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM idempotency_records WHERE organization_id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM sandbox_dispatch_reservations WHERE organization_id = $1 AND status = $2',
        [ORGANIZATION_ID, 'reserved'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(redis.get(redisQuotaKey())).resolves.toBeNull();
  });

  it('allows a completed replay after the Sandbox dispatch cap is exhausted', async () => {
    const first = await grade('sandbox-http-replay-1');
    expect(first.statusCode).toBe(200);
    await sandbox.query(
      `INSERT INTO sandbox_dispatch_reservations
         (request_id, organization_id, month_start)
       SELECT 'seed-' || n, $1,
         date_trunc('month', now() AT TIME ZONE 'UTC')::date
       FROM generate_series(1, 24) AS n`,
      [ORGANIZATION_ID],
    );

    const replay = await grade('sandbox-http-replay-1');
    const denied = await grade('sandbox-http-replay-new-key');

    expect(replay.statusCode).toBe(200);
    expect(denied.statusCode).toBe(429);
    expect(denied.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });
    expect(downstreamCalls).toBe(1);
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM sandbox_dispatch_reservations WHERE status = $1',
        ['reserved'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 25 }] });
  });

  it('grades Writing Task 2 with a customer Sandbox key', async () => {
    const response = await requestGrade(
      TASK2_PATH,
      TASK2_INPUT,
      'sandbox-http-task2-1',
    );

    expect(response.statusCode).toBe(200);
    expect(downstreamCalls).toBe(1);
    await expect(
      sandbox.query(
        'SELECT operation FROM sandbox_dispatch_reservations r JOIN usage_records u USING (request_id) WHERE u.organization_id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ operation: 'writing.task2.grade' }] });
  });

  it('accepts a Declared User ID when the Organization has no active identity configuration', async () => {
    await controlPlane.query(
      "UPDATE organization_identity_configs SET status = 'disabled' WHERE organization_id = $1",
      [ORGANIZATION_ID],
    );

    let response: LightMyRequestResponse;
    try {
      response = await requestGrade(
        GRADE_PATH,
        GRADE_INPUT,
        'sandbox-http-declared-user',
        'api.sandbox.test',
        'customer-user-123',
      );
    } finally {
      await controlPlane.query(
        "UPDATE organization_identity_configs SET status = 'active' WHERE organization_id = $1",
        [ORGANIZATION_ID],
      );
    }

    expect(response.statusCode).toBe(200);
    expect(downstreamCalls).toBe(1);
  });

  it('rejects the Sandbox-only key on the production hostname', async () => {
    const response = await grade(
      'sandbox-http-wrong-host',
      'api.production.test',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'ENVIRONMENT_NOT_ALLOWED' },
    });
    expect(downstreamCalls).toBe(0);
  });

  it('limits a Sandbox API key to five requests per minute', async () => {
    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await grade(`sandbox-http-rate-${String(index)}`));
    }

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200, 429,
    ]);
    expect(responses[5]?.json()).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    expect(downstreamCalls).toBe(5);
  });

  it('honors API-key revocation on the next request without a successful-key cache', async () => {
    expect((await grade('sandbox-http-revoke-first')).statusCode).toBe(200);
    await controlPlane.query('UPDATE api_keys SET status = $1 WHERE id = $2', [
      'revoked',
      apiKey.id,
    ]);

    const revoked = await grade('sandbox-http-revoke-next');

    expect(revoked.statusCode).toBe(401);
    expect(downstreamCalls).toBe(1);
  });

  it('honors Organization suspension on the next request', async () => {
    expect((await grade('sandbox-http-suspension-first')).statusCode).toBe(200);
    await controlPlane.query(
      "UPDATE organizations SET status = 'suspended' WHERE id = $1",
      [ORGANIZATION_ID],
    );

    const suspended = await grade('sandbox-http-suspension-next');

    expect(suspended.statusCode).toBe(403);
    expect(suspended.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(downstreamCalls).toBe(1);
  });

  it('fails closed when the Sandbox control-plane reader cannot read API keys', async () => {
    await controlPlane.query(
      `REVOKE SELECT (key_hash) ON api_keys FROM ${controlPlaneReaderRole}`,
    );

    let response: LightMyRequestResponse;
    try {
      response = await grade('sandbox-http-control-plane-down');
    } finally {
      await controlPlane.query(
        `GRANT SELECT (key_hash) ON api_keys TO ${controlPlaneReaderRole}`,
      );
    }

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(downstreamCalls).toBe(0);
  });
});

import { ulid } from 'ulid';

import { migrateSandboxOrganization } from '@/cli/sandbox-control-plane-migration';
import { PostgresSandboxDispatchBudget } from '@/modules/gateway/infrastructure/postgres-sandbox-dispatch-budget';
import { ApiKeyAuthenticator } from '@/modules/identity/application/api-key-authenticator';
import { generateApiKey } from '@/modules/identity/domain/api-key';
import { PostgresApiKeyRepository } from '@/modules/identity/infrastructure/postgres-api-key.repository';
import { createPostgresIdentityClient } from '@/modules/identity/infrastructure/postgres-identity.client';
import {
  createSandboxTestPool,
  createTestPool,
  sandboxTestDatabaseUrl,
  testDatabaseUrl,
} from './database';

const ORGANIZATION_ID = 'org_demo_migration';
const ACTOR_ID = `usr_${ulid()}`;
const ISSUER = 'https://demo-migration.example.test';

let sandbox: ReturnType<typeof createSandboxTestPool>;
let controlPlane: ReturnType<typeof createTestPool>;
let apiKey: ReturnType<typeof generateApiKey>;

beforeAll(() => {
  sandbox = createSandboxTestPool();
  controlPlane = createTestPool();
});

beforeEach(async () => {
  await sandbox.query(
    `TRUNCATE organization_audit_events, organization_identity_configs,
       api_keys, organization_invitations, organization_members,
       auth_identities, user_accounts, idempotency_records, usage_records,
       sandbox_dispatch_reservations, organizations CASCADE`,
  );
  await controlPlane.query(
    `TRUNCATE organization_audit_events, organization_identity_configs,
       api_keys, organization_invitations, organization_members,
       auth_identities, user_accounts, organizations CASCADE`,
  );
  apiKey = generateApiKey('ak_demo_preserved');
  await sandbox.query(
    `INSERT INTO organizations
       (id, name, entitlements, rate_limit_rpm, max_concurrent,
        monthly_request_quota, hard_stop_on_quota)
     VALUES ($1, 'Demo Organization', ARRAY['writing', 'speaking'], 60, 3, 1, true)`,
    [ORGANIZATION_ID],
  );
  await sandbox.query(
    `INSERT INTO api_keys
       (id, organization_id, key_hash, key_prefix, name, scopes,
        allowed_environments, status)
     VALUES ($1, $2, decode($3, 'hex'), $4, 'Demo key',
       ARRAY['writing.grade', 'speaking.grade'], ARRAY['development'], 'active')`,
    [apiKey.id, ORGANIZATION_ID, apiKey.hash, apiKey.prefix],
  );
  await sandbox.query(
    `INSERT INTO organization_identity_configs
       (organization_id, issuer, jwks_url, public_keys_jwks,
        allowed_algorithms, max_assertion_ttl_seconds, status)
     VALUES ($1, $2, NULL,
       '{"keys":[{"kty":"RSA","n":"AQAB","e":"AQAB","kid":"demo"}]}'::jsonb,
       ARRAY['RS256'], 300, 'active')`,
    [ORGANIZATION_ID, ISSUER],
  );
  await sandbox.query(
    `INSERT INTO usage_records
       (request_id, organization_id, api_key_id, service, operation,
        environment, outcome, http_status, billable_requests,
        metering_status, total_ms)
     VALUES ('req_demo_history', $1, $2, 'writing', 'writing.task1.grade',
       'sandbox', 'success', 200, 1, 'not_applicable', 10)`,
    [ORGANIZATION_ID, apiKey.id],
  );
  await sandbox.query(
    `INSERT INTO usage_records
       (request_id, organization_id, api_key_id, service, operation,
        environment, outcome, http_status, billable_requests,
        metering_status, total_ms)
     VALUES ('req_demo_pre_dispatch', $1, $2, 'writing', 'writing.task1.grade',
       'sandbox', 'downstream_error', 503, 0, 'not_applicable', 5)`,
    [ORGANIZATION_ID, apiKey.id],
  );
  await sandbox.query(
    `INSERT INTO sandbox_dispatch_reservations
       (request_id, organization_id, month_start, status, created_at, released_at)
     VALUES ('req_demo_pre_dispatch', $1,
       date_trunc('month', now() AT TIME ZONE 'UTC')::date,
       'released', now(), now())`,
    [ORGANIZATION_ID],
  );
  await sandbox.query(
    `INSERT INTO idempotency_records
       (organization_id, operation, idempotency_key, request_fingerprint,
        state, request_id, response_status, response_body, created_at,
        completed_at, expires_at)
     VALUES ($1, 'writing.task1.grade', 'demo-history', decode(repeat('a', 64), 'hex'),
       'completed', 'req_demo_history', 200, '{"saved":true}'::jsonb,
       now(), now(), now() + interval '24 hours')`,
    [ORGANIZATION_ID],
  );
});

afterAll(async () => {
  await sandbox.end();
  await controlPlane.end();
});

describe('guarded Sandbox control-plane migration', () => {
  it('dry-runs, preserves the key id and hash, retains sandbox history, and is safe to rerun', async () => {
    await expect(
      migrateSandboxOrganization(sandbox, controlPlane, ORGANIZATION_ID, false),
    ).resolves.toEqual({
      status: 'dry_run',
      organizations: 1,
      apiKeys: 1,
      identityConfigs: 1,
      historicalDispatches: 1,
    });
    await expect(
      controlPlane.query('SELECT count(*)::int AS count FROM organizations'),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(
      migrateSandboxOrganization(sandbox, controlPlane, ORGANIZATION_ID, true),
    ).resolves.toMatchObject({
      status: 'applied',
      historicalDispatches: 1,
    });

    const movedKey = await controlPlane.query<{
      id: string;
      hash_hex: string;
      allowed_environments: string[];
    }>(
      `SELECT id, encode(key_hash, 'hex') AS hash_hex, allowed_environments
       FROM api_keys WHERE organization_id = $1`,
      [ORGANIZATION_ID],
    );
    expect(movedKey.rows).toEqual([
      {
        id: apiKey.id,
        hash_hex: apiKey.hash,
        allowed_environments: ['sandbox'],
      },
    ]);
    const identityClient = createPostgresIdentityClient(testDatabaseUrl());
    try {
      const authenticator = new ApiKeyAuthenticator(
        new PostgresApiKeyRepository(identityClient),
        {
          get: async () => undefined,
          set: async () => undefined,
          setMiss: async () => undefined,
          delete: async () => undefined,
        },
        {
          get: async () => 0,
          recordFailure: async () => 1,
        },
      );
      await expect(
        authenticator.authenticate({
          value: apiKey.raw,
          environment: 'sandbox',
          clientIp: '127.0.0.1',
        }),
      ).resolves.toMatchObject({
        organizationId: ORGANIZATION_ID,
        apiKeyId: apiKey.id,
        monthlyRequestQuota: 1,
      });
    } finally {
      await identityClient.close();
    }
    await expect(
      controlPlane.query(
        'SELECT issuer FROM organization_identity_configs WHERE organization_id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ issuer: ISSUER }] });
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM organizations WHERE id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM usage_records WHERE request_id = $1',
        ['req_demo_history'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      sandbox.query(
        `SELECT count(*)::int AS count FROM sandbox_dispatch_reservations
         WHERE request_id = 'migration-history:req_demo_pre_dispatch'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM idempotency_records WHERE organization_id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      sandbox.query(
        `SELECT count(*)::int AS count FROM sandbox_dispatch_reservations
         WHERE organization_id = $1 AND status = 'reserved'
           AND month_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    const budget = new PostgresSandboxDispatchBudget(sandboxTestDatabaseUrl());
    try {
      await expect(
        budget.reserve({
          organizationId: ORGANIZATION_ID,
          requestId: 'req_after_migration',
          organizationLimit: 1,
        }),
      ).resolves.toBe(false);
    } finally {
      await budget.onModuleDestroy();
    }
    await expect(
      migrateSandboxOrganization(sandbox, controlPlane, ORGANIZATION_ID, true),
    ).resolves.toMatchObject({ status: 'already_migrated' });
  });

  it('refuses to move an Organization with dependent control-plane records', async () => {
    await sandbox.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, 'demo-owner', 'active', now(), now())`,
      [ACTOR_ID],
    );
    await sandbox.query(
      `INSERT INTO organization_members
         (organization_id, user_account_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [ORGANIZATION_ID, ACTOR_ID],
    );

    await expect(
      migrateSandboxOrganization(sandbox, controlPlane, ORGANIZATION_ID, true),
    ).rejects.toThrow('organization_members:1');
    await expect(
      controlPlane.query('SELECT count(*)::int AS count FROM organizations'),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      sandbox.query(
        'SELECT count(*)::int AS count FROM organizations WHERE id = $1',
        [ORGANIZATION_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});

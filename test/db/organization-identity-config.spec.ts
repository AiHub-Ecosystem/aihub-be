import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { AppError } from '../../src/common/errors/app-error';
import { createRequestContext } from '../../src/common/request-context/request-context.factory';
import type { SaveOrganizationIdentityConfigInput } from '../../src/modules/identity/application/organization-identity-config-repository.port';
import {
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationIdentityConfigRepository } from '../../src/modules/identity/infrastructure/postgres-organization-identity-config.repository';

import { createTestPool, resetIdentityTables } from './database';

let pool: Pool;
let client: PostgresIdentityTransactionalClient & { close(): Promise<void> };
let repository: PostgresOrganizationIdentityConfigRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresIdentityClient(
    (pool.options as { connectionString?: string }).connectionString ?? '',
  );
  repository = new PostgresOrganizationIdentityConfigRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

let organizationId: string;
let ownerId: string;

beforeEach(async () => {
  await resetIdentityTables(pool);
  organizationId = `org_${ulid()}`;
  await createOrganization(organizationId);
  ownerId = await seedMember(organizationId, 'owner');
});

async function createOrganization(id: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations
       (id, name, entitlements, rate_limit_rpm, max_concurrent,
        monthly_request_quota, hard_stop_on_quota)
     VALUES ($1, 'Acme', ARRAY['writing'], 60, 5, 100, true)`,
    [id],
  );
}

async function seedMember(
  orgId: string,
  role: 'owner' | 'admin',
): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`],
  );
  await pool.query(
    `INSERT INTO organization_members
       (organization_id, user_account_id, role, status)
     VALUES ($1, $2, $3, 'active')`,
    [orgId, id, role],
  );
  return id;
}

function input(
  overrides: Partial<SaveOrganizationIdentityConfigInput> = {},
): SaveOrganizationIdentityConfigInput {
  const userId = overrides.userId ?? ownerId;
  return {
    context: createRequestContext({
      requestId: `req_${ulid()}`,
      receivedAt: new Date(),
      deadlineMs: 5_000,
      userId,
      scopes: [],
    }),
    userId,
    organizationId,
    issuer: 'https://acme.edu',
    jwksUrl: null,
    publicKeysJwks: {
      keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'rsa-1' }],
    },
    allowedAlgorithms: ['RS256', 'ES256'],
    maxAssertionTtlSeconds: 300,
    sourceKind: 'inline',
    ...overrides,
  };
}

async function auditEvents(): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT action, outcome, target_type, target_id, target_label, detail
     FROM organization_audit_events WHERE organization_id = $1`,
    [organizationId],
  );
  return rows;
}

describe('Organization identity configuration against PostgreSQL', () => {
  it('creates an active config and commits only the approved audit details', async () => {
    const saved = await repository.saveForOwner(input());

    expect(saved).toMatchObject({
      kind: 'saved',
      config: {
        organizationId,
        issuer: 'https://acme.edu',
        status: 'active',
      },
    });
    expect(await auditEvents()).toEqual([
      {
        action: 'organization.identity_config_set',
        outcome: 'applied',
        target_type: 'organization',
        target_id: organizationId,
        target_label: 'Identity configuration',
        detail: { issuer: 'https://acme.edu', sourceKind: 'inline' },
      },
    ]);
    expect(JSON.stringify(await auditEvents())).not.toContain('rsa-1');
    expect(JSON.stringify(await auditEvents())).not.toContain('AQAB');
  });

  it('treats an identical retry as unchanged and writes no duplicate audit event', async () => {
    const first = await repository.saveForOwner(input());
    const retried = await repository.saveForOwner(input());

    expect(retried.kind).toBe('unchanged');
    if (first.kind === 'forbidden' || retried.kind === 'forbidden') {
      throw new Error('Owner config saves unexpectedly forbidden');
    }
    expect(BigInt(retried.config.jwksCacheVersion ?? '0')).toBe(
      BigInt(first.config.jwksCacheVersion ?? '0') + 1n,
    );
    expect(await auditEvents()).toHaveLength(1);
  });

  it('preserves an operator-disabled status when the owner replaces the config', async () => {
    await repository.saveForOwner(input());
    await pool.query(
      `UPDATE organization_identity_configs
       SET status = 'disabled' WHERE organization_id = $1`,
      [organizationId],
    );

    const replaced = await repository.saveForOwner(
      input({ issuer: 'https://new-issuer.acme.edu' }),
    );

    expect(replaced).toMatchObject({
      kind: 'saved',
      config: { issuer: 'https://new-issuer.acme.edu', status: 'disabled' },
    });
    expect(await auditEvents()).toHaveLength(2);
  });

  it('rejects an issuer already owned by another Organization', async () => {
    const otherOrganizationId = `org_${ulid()}`;
    await createOrganization(otherOrganizationId);
    const otherOwner = await seedMember(otherOrganizationId, 'owner');
    await repository.saveForOwner(input());

    const error = await repository
      .saveForOwner(
        input({
          organizationId: otherOrganizationId,
          userId: otherOwner,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(
      'ORGANIZATION_IDENTITY_ISSUER_CONFLICT',
    );
    const { rows } = await pool.query(
      'SELECT organization_id FROM organization_identity_configs ORDER BY organization_id',
    );
    expect(rows).toEqual([{ organization_id: organizationId }]);
    expect(await auditEvents()).toHaveLength(1);
  });

  it('refuses a non-owner in the transaction without writing config or audit', async () => {
    const adminId = await seedMember(organizationId, 'admin');

    await expect(
      repository.saveForOwner(input({ userId: adminId })),
    ).resolves.toEqual({ kind: 'forbidden' });
    const { rows } = await pool.query(
      'SELECT organization_id FROM organization_identity_configs',
    );
    expect(rows).toEqual([]);
    expect(await auditEvents()).toEqual([]);
  });
});

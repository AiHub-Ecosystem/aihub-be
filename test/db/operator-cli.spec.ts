import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const ROOT = join(__dirname, '../..');

// `scripts/cli.mjs` loads its API-key generator and command runners from the
// build, and runs `main()` the moment it is imported, so nothing but a real
// process can exercise it. That left `key:create` broken for a stretch with no
// test noticing. CI builds before this lane; a bare local run skips instead of
// failing on a missing build.
const BUILT = [
  'dist/modules/identity/domain/api-key.js',
  'dist/cli/organization-api-key.js',
].every((path) => existsSync(join(ROOT, path)));
const withBuild = BUILT ? describe : describe.skip;

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/cli.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      CONTROL_PLANE_DATABASE_URL: testDatabaseUrl(),
      // Empty, so a revocation reports an unset cache instead of reaching a
      // Redis this lane does not own.
      REDIS_URL: '',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function seedOperator(username: string): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, username],
  );
  return id;
}

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await pool.query(sql)).rows;
}

withBuild('operator CLI against PostgreSQL', () => {
  async function organization(): Promise<string> {
    const created = cli(
      'org:create',
      '--name',
      'Acme',
      '--entitlements',
      'writing',
    );
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
    return created.stdout;
  }

  it('issues a key, records it with the operator as actor, and prints the raw key once', async () => {
    const operatorId = await seedOperator('ops-alice');
    const organizationId = await organization();

    const created = cli(
      'key:create',
      '--org',
      organizationId,
      '--actor',
      'ops-alice',
      '--name',
      'Prod backend',
      '--scopes',
      'writing.grade',
      '--envs',
      'production',
    );

    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/^aihub_sk_[A-Za-z0-9]{43}$/);
    expect(await rows('SELECT status FROM api_keys')).toEqual([
      { status: 'active' },
    ]);
    const events = await rows(
      'SELECT action, actor_user_account_id, detail FROM organization_audit_events',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'api_key.created',
      actor_user_account_id: operatorId,
    });
    expect(JSON.stringify(events)).not.toContain(created.stdout);
  });

  it('revokes a key once, records one event, and succeeds again without a second', async () => {
    await seedOperator('ops-alice');
    const organizationId = await organization();
    cli(
      'key:create',
      '--org',
      organizationId,
      '--actor',
      'ops-alice',
      '--name',
      'k',
    );
    const [key] = await rows('SELECT id FROM api_keys');
    const keyId = String(key?.id);

    const first = cli('key:revoke', '--key', keyId, '--actor', 'ops-alice');
    const repeat = cli('key:revoke', '--key', keyId, '--actor', 'ops-alice');

    expect(first.status).toBe(0);
    expect(repeat.status).toBe(0);
    expect(await rows('SELECT status FROM api_keys')).toEqual([
      { status: 'revoked' },
    ]);
    expect(
      await rows(
        "SELECT 1 FROM organization_audit_events WHERE action = 'api_key.revoked'",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['no actor', ['key:create', '--org', 'org_x', '--name', 'k']],
    [
      'an unknown actor',
      ['key:create', '--org', 'org_x', '--actor', 'nobody', '--name', 'k'],
    ],
    [
      'an unknown key',
      ['key:revoke', '--key', 'ak_nope', '--actor', 'ops-alice'],
    ],
    ['an unknown command', ['key:frobnicate']],
  ])('refuses %s as a usage error and writes nothing', async (_, args) => {
    await seedOperator('ops-alice');

    const result = cli(...args);

    expect(result.status).toBe(2);
    expect(await rows('SELECT 1 FROM api_keys')).toEqual([]);
    expect(await rows('SELECT 1 FROM organization_audit_events')).toEqual([]);
  });
});

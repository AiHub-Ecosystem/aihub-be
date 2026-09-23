import { Pool } from 'pg';

/**
 * Connection helpers for the database-backed lane.
 *
 * The lane runs against a disposable database created by its global setup, so
 * nothing here ever points at a developer's working database: the name is
 * fixed, dropped, and rebuilt from the repository's own migrations on every
 * run.
 */

/**
 * The lane's single default, matching the `postgres` service in
 * `docker-compose.yml` and the service credentials in the CI database job.
 * Override it with `DB_LANE_ADMIN_URL` to point the lane elsewhere.
 */
const DEFAULT_ADMIN_URL = 'postgres://aihub:change-me@localhost:5432/aihub';
const TEST_DATABASE_NAME = 'aihub_db_lane';

export function adminDatabaseUrl(): string {
  const configured = process.env.DB_LANE_ADMIN_URL?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : DEFAULT_ADMIN_URL;
}

/**
 * Host and database only. The admin URL carries a password, so it never
 * reaches an error message or a log line.
 */
export function adminTarget(): string {
  const admin = new URL(adminDatabaseUrl());
  return `${admin.host}${admin.pathname}`;
}

export function testDatabaseUrl(): string {
  const admin = new URL(adminDatabaseUrl());
  admin.pathname = `/${TEST_DATABASE_NAME}`;
  return admin.toString();
}

export { TEST_DATABASE_NAME };

export function createTestPool(): Pool {
  return new Pool({ connectionString: testDatabaseUrl(), max: 4 });
}

/**
 * Empties every table the identity slices write to. `RESTART IDENTITY CASCADE`
 * keeps one test's rows from deciding another's outcome, which matters here
 * because the invariants under test are about durable state.
 */
export async function resetIdentityTables(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      organization_audit_events,
      api_keys,
      organization_invitations,
      organization_members,
      auth_identities,
      user_accounts,
      organizations
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Waits until PostgreSQL reports a backend blocked by `holderPid` and returns
 * that waiting backend's pid.
 *
 * This replaces a sleep-then-assert: a timing check is only ever evidence in
 * the green direction, and would pass for an implementation that never locked
 * but happened to be slow.
 */
export async function waitForBlockedBy(
  pool: Pool,
  holderPid: number | undefined,
  timeoutMs = 5_000,
): Promise<number> {
  if (holderPid === undefined) {
    throw new Error('the holding connection reported no backend pid');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const blocked = await pool.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE $1 = ANY (pg_blocking_pids(pid))
       LIMIT 1`,
      [holderPid],
    );
    const waitingPid = blocked.rows[0]?.pid;
    if (waitingPid !== undefined) {
      return waitingPid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `no backend became blocked by pid ${holderPid} within ${timeoutMs}ms`,
  );
}

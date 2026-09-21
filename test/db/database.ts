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
      organization_invitations,
      organization_members,
      auth_identities,
      user_accounts,
      organizations
    RESTART IDENTITY CASCADE
  `);
}

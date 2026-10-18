import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

import { databaseUrlsForLane } from '../../../scripts/checks/db-lane/database-targets';
import { withOwnedPostgresDatabase } from '../../../scripts/checks/db-lane/ownership';
import {
  DATABASE_LANE_POSTGRES_TIMEOUTS,
  TEST_DATABASE_NAME,
  adminDatabaseUrl,
  adminTarget,
  sandboxTestDatabaseUrl,
  testDatabaseUrl,
} from './database';
import {
  DATABASE_LANE_TEMPLATE_NAME,
  databaseTemplateAction,
  databaseTemplateDescription,
  migrationFingerprint,
} from './database-template';
import type { MigrationFile } from './database-template';
import { timeDatabasePhase } from './lane-timing';

const MIGRATIONS_DIR = join(__dirname, '../../../prisma/migrations');

function databaseUrls(): string[] {
  return databaseUrlsForLane(
    TEST_DATABASE_NAME,
    testDatabaseUrl(),
    sandboxTestDatabaseUrl(),
  );
}

function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.slice(1);
}

function templateDatabaseUrl(): string {
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${DATABASE_LANE_TEMPLATE_NAME}`;
  return url.toString();
}

async function dropTestDatabases(admin: Client): Promise<void> {
  for (const url of databaseUrls()) {
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseName(url)} WITH (FORCE)`,
    );
  }
}

/**
 * Builds the reusable migration template from the repository's migration files.
 *
 * They are applied here rather than by shelling out to `scripts/cli/migrate.mjs`:
 * that script loads the runtime connection environment when `dist/` is built,
 * which overwrites `DATABASE_URL` and would point this lane at whatever
 * database the developer's runtime secrets name. Reading the same files keeps
 * the schema honest while making it impossible for the lane to reach past the
 * database it created.
 */
export default async function globalSetup(): Promise<void> {
  const admin = new Client({
    connectionString: adminDatabaseUrl(),
    ...DATABASE_LANE_POSTGRES_TIMEOUTS,
  });

  let testDatabaseCreationStarted = false;
  try {
    await timeDatabasePhase('PostgreSQL admin connection', async () => {
      try {
        await admin.connect();
      } catch {
        throw new Error(
          `The database lane needs PostgreSQL at ${adminTarget()}.`,
        );
      }
    });
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw error;
  }

  try {
    const adminDatabaseName = new URL(adminDatabaseUrl()).pathname.slice(1);
    const withAdminDatabaseOwnership = <T>(operation: () => Promise<T>) =>
      withOwnedPostgresDatabase(admin, adminDatabaseName, operation);

    await withAdminDatabaseOwnership(async () => {
      const migrations = await timeDatabasePhase<MigrationFile[]>(
        'migration file discovery',
        async () => {
          const entries = await readdir(MIGRATIONS_DIR, {
            withFileTypes: true,
          });
          return Promise.all(
            entries
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort()
              .map(async (name) => ({
                name,
                sql: await readFile(
                  join(MIGRATIONS_DIR, name, 'migration.sql'),
                  'utf8',
                ),
              })),
          );
        },
      );

      const fingerprint = migrationFingerprint(migrations);
      await timeDatabasePhase('migration template preparation', async () => {
        const template = await admin.query<{
          owner: string;
          connected_role: string;
          is_template: boolean;
          allow_connections: boolean;
          description: string | null;
        }>(
          `SELECT pg_get_userbyid(datdba) AS owner,
                current_user AS connected_role,
                datistemplate AS is_template,
                datallowconn AS allow_connections,
                shobj_description(oid, 'pg_database') AS description
         FROM pg_database
         WHERE datname = $1`,
          [DATABASE_LANE_TEMPLATE_NAME],
        );
        const existing = template.rows[0];
        if (existing !== undefined) {
          const action = databaseTemplateAction(
            existing.description,
            fingerprint,
          );
          if (
            existing.owner !== existing.connected_role ||
            action === 'unowned'
          ) {
            throw new Error(
              `Database lane template ${DATABASE_LANE_TEMPLATE_NAME} already exists but is not owned by this lane; refusing to replace it.`,
            );
          }
          if (
            action === 'reuse' &&
            existing.is_template &&
            !existing.allow_connections
          ) {
            return;
          }
          await admin.query(
            `DROP DATABASE ${DATABASE_LANE_TEMPLATE_NAME} WITH (FORCE)`,
          );
        }

        await admin.query(
          `CREATE DATABASE ${DATABASE_LANE_TEMPLATE_NAME} WITH ALLOW_CONNECTIONS false`,
        );
        let created = true;
        try {
          await admin.query(
            `COMMENT ON DATABASE ${DATABASE_LANE_TEMPLATE_NAME} IS '${databaseTemplateDescription(fingerprint, 'building')}'`,
          );
          await admin.query(
            `REVOKE CONNECT ON DATABASE ${DATABASE_LANE_TEMPLATE_NAME} FROM PUBLIC`,
          );
          await admin.query(
            `ALTER DATABASE ${DATABASE_LANE_TEMPLATE_NAME} WITH ALLOW_CONNECTIONS true`,
          );

          const target = new Client({
            connectionString: templateDatabaseUrl(),
            ...DATABASE_LANE_POSTGRES_TIMEOUTS,
          });
          await timeDatabasePhase(
            `migration replay (${migrations.length} files)`,
            async () => {
              try {
                await target.connect();
                for (const migration of migrations) {
                  try {
                    await target.query(migration.sql);
                  } catch {
                    throw new Error(`Migration failed: ${migration.name}`);
                  }
                }
              } finally {
                await target.end().catch(() => undefined);
              }
            },
          );

          await admin.query(
            `ALTER DATABASE ${DATABASE_LANE_TEMPLATE_NAME} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
          );
          await admin.query(
            `COMMENT ON DATABASE ${DATABASE_LANE_TEMPLATE_NAME} IS '${databaseTemplateDescription(fingerprint, 'ready')}'`,
          );
          created = false;
        } catch (error) {
          if (created) {
            try {
              await admin.query(
                `DROP DATABASE ${DATABASE_LANE_TEMPLATE_NAME} WITH (FORCE)`,
              );
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'Database lane template build failed and cleanup also failed.',
              );
            }
          }
          throw error;
        }
      });

      testDatabaseCreationStarted = true;
      await timeDatabasePhase('test database creation', async () => {
        for (const url of databaseUrls()) {
          const name = databaseName(url);
          await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
          await admin.query(
            `CREATE DATABASE ${name} TEMPLATE ${DATABASE_LANE_TEMPLATE_NAME}`,
          );
        }
      });
    });
  } catch (error) {
    if (!testDatabaseCreationStarted) throw error;
    try {
      const adminDatabaseName = new URL(adminDatabaseUrl()).pathname.slice(1);
      await withOwnedPostgresDatabase(admin, adminDatabaseName, () =>
        timeDatabasePhase('test database cleanup after setup failure', () =>
          dropTestDatabases(admin),
        ),
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Database lane setup failed and test database cleanup also failed.',
      );
    }
    throw error;
  } finally {
    await admin.end();
  }
}

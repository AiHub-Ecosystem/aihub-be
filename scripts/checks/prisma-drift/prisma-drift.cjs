#!/usr/bin/env node
/**
 * Schema/migration drift contract (ADR-0088, #40).
 *
 * `prisma/schema.prisma` describes the control-plane schema, and
 * `database/migrations/` builds it. They are two copies of one thing, so this
 * file decides what "they disagree" means and runs the comparison against a
 * database built from the migrations. `check-prisma-drift.mjs` is the CLI over
 * it, and the database lane exercises it against the real migration history.
 *
 * `prisma migrate diff --script` prints a lone comment when the two sides
 * already agree. Anything else is a statement that would change the database.
 */
const { spawnSync } = require('node:child_process');
const { readFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { Client } = require('pg');

const EMPTY_DIFF = '-- This is an empty migration.';

const SCRATCH_DATABASE_NAME = 'aihub_prisma_drift';

/**
 * The statements a drifted pair produces, or `[]` when the pair agrees.
 *
 * A pure function of the CLI's diff output, so a spec can pin both directions
 * without a PostgreSQL instance.
 */
function driftStatements(output) {
  if (output.includes(EMPTY_DIFF)) {
    return [];
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'));
}

function scratchDatabaseUrl(adminUrl, name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Host and database only. The admin URL carries a password, so it never
 * reaches an error message or a log line.
 */
function adminTarget(adminUrl) {
  const admin = new URL(adminUrl);
  return `${admin.host}${admin.pathname}`;
}

async function applyMigrations(url, migrationsDir) {
  const target = new Client({ connectionString: url });
  await target.connect();
  try {
    const entries = (await readdir(migrationsDir)).filter((name) =>
      name.endsWith('.sql'),
    );
    entries.sort();

    for (const filename of entries) {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');
      try {
        await target.query(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${filename}`, { cause: error });
      }
    }
  } finally {
    await target.end();
  }
}

async function withAdmin(adminUrl, work) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/**
 * Builds a scratch database from every migration in `migrationsDir` and returns
 * the statements Prisma would apply to reach `schemaPath`. `[]` means the two
 * are the same thing. The scratch database is created and dropped here, so a
 * developer's working database is never touched.
 */
async function driftAgainstMigrations({
  adminUrl,
  migrationsDir,
  schemaPath,
  scratchName = SCRATCH_DATABASE_NAME,
}) {
  try {
    await withAdmin(adminUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${scratchName}`);
    });
  } catch (error) {
    throw new Error(
      `The drift check needs PostgreSQL at ${adminTarget(adminUrl)}.`,
      { cause: error },
    );
  }

  try {
    const scratchUrl = scratchDatabaseUrl(adminUrl, scratchName);
    await applyMigrations(scratchUrl, migrationsDir);

    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const diff = spawnSync(
      command,
      [
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        schemaPath,
        '--script',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, AIHUB_DRIFT_CHECK_DATABASE_URL: scratchUrl },
        shell: process.platform === 'win32',
      },
    );

    if (diff.status !== 0) {
      throw new Error(
        `prisma migrate diff failed: ${diff.stderr || diff.stdout}`,
      );
    }

    return driftStatements(diff.stdout);
  } finally {
    await withAdmin(adminUrl, (admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`),
    );
  }
}

module.exports = { driftStatements, driftAgainstMigrations };

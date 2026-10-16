#!/usr/bin/env node
/**
 * Schema/migration drift contract (ADR-0088, #40).
 *
 * `prisma/schema.prisma` describes the control-plane schema, and
 * `prisma/migrations/` builds it. They are two copies of one thing, so this
 * file decides what "they disagree" means and runs the comparison against a
 * shadow database replayed from the migrations. `check-prisma-drift.mjs` is the CLI over
 * it, and the database lane exercises it against the real migration history.
 *
 * `prisma migrate diff --script` prints a lone comment when the two sides
 * already agree. Anything else is a statement that would change the database.
 */
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Client } = require('pg');

const EMPTY_DIFF = '-- This is an empty migration.';
const PRISMA_CLI = require.resolve('prisma/build/index.js');
const PRISMA_DIFF_TIMEOUT_MS = 120_000;
const POSTGRES_TIMEOUTS = {
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
  statement_timeout: 25_000,
  lock_timeout: 15_000,
};

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

function redactDatabaseUrls(message) {
  return message.replace(
    /(?:postgres(?:ql)?|prisma\+postgres):\/\/[^\s"'`<>]+/gi,
    '<redacted database URL>',
  );
}

async function timePhase(phase, work) {
  const startedAt = performance.now();
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`${phase} failed: ${redactDatabaseUrls(message)}`);
  } finally {
    console.info(
      `[db-lane] ${phase}: ${((performance.now() - startedAt) / 1_000).toFixed(2)}s`,
    );
  }
}

function runDiffProcess({ command, args, timeoutMs, phase, cwd, env }) {
  const startedAt = performance.now();
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env,
      timeout: timeoutMs,
    });

    if (result.error?.code === 'ETIMEDOUT') {
      throw new Error(`${phase} timed out after ${timeoutMs}ms`);
    }
    if (result.error) {
      throw new Error(`${phase} could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const details = redactDatabaseUrls(result.stderr || result.stdout || '');
      throw new Error(
        `${phase} failed with exit code ${result.status}${details ? `: ${details}` : ''}`,
      );
    }

    return result.stdout;
  } finally {
    console.info(
      `[db-lane] ${phase}: ${((performance.now() - startedAt) / 1_000).toFixed(2)}s`,
    );
  }
}

async function withAdmin(adminUrl, work) {
  const admin = new Client({
    connectionString: adminUrl,
    ...POSTGRES_TIMEOUTS,
  });
  let connected = false;
  try {
    try {
      await admin.connect();
      connected = true;
    } catch {
      throw new Error(
        `The drift check needs PostgreSQL at ${adminTarget(adminUrl)}.`,
      );
    }
    return await work(admin);
  } finally {
    if (connected) await admin.end();
  }
}

/**
 * Replays `migrationsDir` into a scratch shadow database and returns the
 * statements Prisma would apply to reach `schemaPath`. `[]` means the two are
 * the same thing. Both scratch databases are created and dropped here, so a
 * developer's working database is never touched.
 */
async function driftAgainstMigrations({
  adminUrl,
  migrationsDir,
  schemaPath,
  scratchName = SCRATCH_DATABASE_NAME,
}) {
  const shadowName = `${scratchName}_shadow`;
  let cleanupRequired = false;
  let failure;
  let drifted;

  try {
    await timePhase('drift scratch database creation', () =>
      withAdmin(adminUrl, async (admin) => {
        cleanupRequired = true;
        await admin.query(
          `DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`,
        );
        await admin.query(`DROP DATABASE IF EXISTS ${shadowName} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${scratchName}`);
        await admin.query(`CREATE DATABASE ${shadowName}`);
      }),
    );

    const scratchUrl = scratchDatabaseUrl(adminUrl, scratchName);
    const shadowUrl = scratchDatabaseUrl(adminUrl, shadowName);
    const output = runDiffProcess({
      command: process.execPath,
      args: [
        PRISMA_CLI,
        'migrate',
        'diff',
        '--from-migrations',
        migrationsDir,
        '--to-schema',
        schemaPath,
        '--script',
      ],
      timeoutMs: PRISMA_DIFF_TIMEOUT_MS,
      phase: 'Prisma migrate diff',
      env: {
        ...process.env,
        AIHUB_DRIFT_CHECK_DATABASE_URL: scratchUrl,
        AIHUB_DRIFT_CHECK_SHADOW_DATABASE_URL: shadowUrl,
      },
    });
    drifted = driftStatements(output);
  } catch (error) {
    failure = error;
  }

  if (cleanupRequired) {
    try {
      await timePhase('drift scratch database cleanup', () =>
        withAdmin(adminUrl, async (admin) => {
          await admin.query(
            `DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`,
          );
          await admin.query(
            `DROP DATABASE IF EXISTS ${shadowName} WITH (FORCE)`,
          );
        }),
      );
    } catch (cleanupError) {
      failure =
        failure === undefined
          ? cleanupError
          : new AggregateError(
              [failure, cleanupError],
              'Prisma drift check failed and scratch database cleanup also failed.',
            );
    }
  }

  if (failure !== undefined) throw failure;
  return drifted;
}

module.exports = { driftStatements, driftAgainstMigrations, runDiffProcess };

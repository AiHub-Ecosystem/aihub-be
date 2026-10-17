const childProcess = require('node:child_process');
const path = require('node:path');

const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_ADMIN_URL = 'postgres://aihub:change-me@localhost:5432/aihub';
// Keep this pair stable across processes: AIHB identifies the project and DBLN the lane.
const DATABASE_LANE_LOCK_KEY = [0x41494842, 0x44424c4e];
const LANE_CONFIGS = {
  db: require.resolve('../../../jest.config.db.cjs'),
  'tenant-isolation': require.resolve(
    '../../../jest.config.tenant-isolation.cjs',
  ),
};

function databaseLaneLockConnectionString(adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function databaseLaneAdminUrl(env) {
  return env.DB_LANE_ADMIN_URL?.trim() || DEFAULT_ADMIN_URL;
}

async function withDatabaseLaneLock(client, run) {
  // shortcut: lock scope is one PostgreSQL server; add Redis-scoped coordination if separate servers can share Redis.
  let acquired = false;
  try {
    await client.connect();
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      DATABASE_LANE_LOCK_KEY,
    );
    if (result.rows[0]?.acquired !== true) {
      const error = new Error('Database validation lane is already held');
      error.code = 'DB_LANE_HELD';
      throw error;
    }
    acquired = true;
    return await run();
  } finally {
    try {
      if (acquired) {
        await client
          .query('SELECT pg_advisory_unlock($1, $2)', DATABASE_LANE_LOCK_KEY)
          .catch(() => undefined);
      }
    } finally {
      await client.end();
    }
  }
}

function runCommand(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    const handlers = [];
    const removeSignalHandlers = () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => child.kill(signal);
      handlers.push([signal, handler]);
      process.on(signal, handler);
    }

    child.once('error', (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once('close', (code) => {
      removeSignalHandlers();
      resolveResult(code ?? 1);
    });
  });
}

async function runDatabaseLane(lane, options = {}) {
  const config = Object.hasOwn(LANE_CONFIGS, lane)
    ? LANE_CONFIGS[lane]
    : undefined;
  if (config === undefined) {
    throw new Error(`Unknown database lane: ${lane}`);
  }

  options = { passthrough: process.argv.slice(3), ...options };

  const env = options.env ?? process.env;
  const adminUrl = databaseLaneAdminUrl(env);
  const lockUrl = databaseLaneLockConnectionString(adminUrl);
  const client =
    options.client ??
    new Client({
      connectionString: lockUrl,
      connectionTimeoutMillis: 10_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
  const run = options.runCommand ?? runCommand;

  return withDatabaseLaneLock(client, async () => {
    const generateExitCode = await run(process.execPath, [
      path.resolve(ROOT, 'scripts/generate/generate-prisma-client.mjs'),
      '--runtime',
      '--timings',
    ]);
    if (generateExitCode !== 0) return generateExitCode;

    return run(process.execPath, [
      require.resolve('jest/bin/jest'),
      '--config',
      config,
      '--runInBand',
      // Anything after the lane name reaches jest, so a caller can ask for a
      // coverage report without giving up the lane lock above.
      ...(options.passthrough ?? []),
    ]);
  });
}

function redactDatabaseUrls(text) {
  return String(text).replace(
    /(?:postgres(?:ql)?|prisma\+postgres):\/\/[^\s"'`<>]+/gi,
    '<redacted database URL>',
  );
}

function safeErrorMessage(error) {
  const collected = [];
  if (error && typeof error.code === 'string' && error.code.length > 0) {
    collected.push(`[${error.code}]`);
  }
  if (Array.isArray(error && error.errors)) {
    for (const nested of error.errors) {
      const nestedMessage = safeErrorMessage(nested);
      if (nestedMessage.length > 0) {
        collected.push(nestedMessage);
      }
    }
  }
  if (error && error.cause !== undefined && error.cause !== error) {
    const causeMessage = safeErrorMessage(error.cause);
    if (causeMessage.length > 0) {
      collected.push(causeMessage);
    }
  }
  const message =
    error instanceof Error
      ? error.message
      : error === undefined || error === null
        ? ''
        : String(error);
  if (typeof message === 'string' && message.trim().length > 0) {
    collected.push(message.trim());
  }
  if (collected.length === 0) {
    return 'unknown error (no message)';
  }
  return redactDatabaseUrls(collected.join('; '));
}

if (require.main === module) {
  runDatabaseLane(process.argv[2]).then(
    (exitCode) => {
      process.exitCode = exitCode;
      return exitCode;
    },
    (error) => {
      if (error?.code === 'DB_LANE_HELD') {
        const adminUrl = databaseLaneAdminUrl(process.env);
        console.error(
          `${error.message} on PostgreSQL server ${new URL(adminUrl).host}. Wait for it to finish before retrying.`,
        );
      } else {
        console.error(
          `Database validation lane failed: ${safeErrorMessage(error)}`,
        );
      }
      process.exitCode = 1;
      return 1;
    },
  );
}

module.exports = {
  databaseLaneLockConnectionString,
  runDatabaseLane,
  safeErrorMessage,
  withDatabaseLaneLock,
};

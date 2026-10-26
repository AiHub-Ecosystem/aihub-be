const childProcess = require('node:child_process');
const path = require('node:path');

const pg = /** @type {typeof import('pg')} */ (require('pg'));
const { Client } = pg;

/** @typedef {'db' | 'tenant-isolation'} DatabaseLane */
/** @typedef {{connect: () => Promise<void>, query: (query: string, values: readonly number[]) => Promise<{rows: readonly {acquired: unknown}[]}>, end: () => Promise<void>}} DatabaseLaneClient */
/** @typedef {{env?: NodeJS.ProcessEnv, client?: DatabaseLaneClient, passthrough?: string[], runCommand?: (command: string, args: string[]) => Promise<number>}} DatabaseLaneOptions */

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

/** @param {string} connectionString @returns {DatabaseLaneClient} */
function createPostgresLaneClient(connectionString) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });

  return {
    connect: () => client.connect(),
    query: async (query, values) => {
      const result = await client.query(query, [...values]);
      return { rows: result.rows };
    },
    end: () => client.end(),
  };
}

/** @param {string} adminUrl */
function databaseLaneLockConnectionString(adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/** @param {NodeJS.ProcessEnv} env */
function databaseLaneAdminUrl(env) {
  return env.DB_LANE_ADMIN_URL?.trim() || DEFAULT_ADMIN_URL;
}

/** @template T @param {DatabaseLaneClient} client @param {() => Promise<T>} run @returns {Promise<T>} */
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
      /** @type {Error & {code: string}} */
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

/** @param {string} command @param {string[]} args @returns {Promise<number>} */
function runCommand(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    /** @type {Array<[NodeJS.Signals, () => void]>} */
    const handlers = [];
    const removeSignalHandlers = () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    };

    /** @type {NodeJS.Signals[]} */
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
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

/** @param {string | undefined} lane @param {DatabaseLaneOptions} [options] @returns {Promise<number>} */
async function runDatabaseLane(lane, options = {}) {
  /** @type {DatabaseLane | undefined} */
  const validLane =
    lane === 'db' || lane === 'tenant-isolation' ? lane : undefined;
  const config = validLane === undefined ? undefined : LANE_CONFIGS[validLane];
  if (config === undefined) {
    throw new Error(`Unknown database lane: ${lane}`);
  }

  options = { passthrough: process.argv.slice(3), ...options };

  const env = options.env ?? process.env;
  const adminUrl = databaseLaneAdminUrl(env);
  const lockUrl = databaseLaneLockConnectionString(adminUrl);
  const client = options.client ?? createPostgresLaneClient(lockUrl);
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

/** @param {string} text */
function redactDatabaseUrls(text) {
  return String(text).replace(
    /(?:postgres(?:ql)?|prisma\+postgres):\/\/[^\s"'`<>]+/gi,
    '<redacted database URL>',
  );
}

/** @param {unknown} error */
function safeErrorMessage(error) {
  /** @param {string} name @returns {unknown} */
  const read = (name) =>
    typeof error === 'object' && error !== null
      ? /** @type {unknown} */ (Reflect.get(error, name))
      : undefined;
  /** @type {string[]} */
  const collected = [];
  const code = read('code');
  if (typeof code === 'string' && code.length > 0) {
    collected.push(`[${code}]`);
  }
  const errors = read('errors');
  if (Array.isArray(errors)) {
    for (const nested of /** @type {unknown[]} */ (errors)) {
      const nestedMessage = safeErrorMessage(nested);
      if (nestedMessage.length > 0) {
        collected.push(nestedMessage);
      }
    }
  }
  const cause = read('cause');
  if (cause !== undefined && cause !== error) {
    const causeMessage = safeErrorMessage(cause);
    if (causeMessage.length > 0) {
      collected.push(causeMessage);
    }
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'number' ||
            typeof error === 'boolean' ||
            typeof error === 'bigint' ||
            typeof error === 'symbol'
          ? String(error)
          : '';
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
      /** @type {unknown} */
      const caughtError = error;
      const code =
        typeof caughtError === 'object' && caughtError !== null
          ? /** @type {unknown} */ (Reflect.get(caughtError, 'code'))
          : undefined;
      if (code === 'DB_LANE_HELD' && caughtError instanceof Error) {
        const adminUrl = databaseLaneAdminUrl(process.env);
        console.error(
          `${caughtError.message} on PostgreSQL server ${new URL(adminUrl).host}. Wait for it to finish before retrying.`,
        );
      } else {
        console.error(
          `Database validation lane failed: ${safeErrorMessage(caughtError)}`,
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

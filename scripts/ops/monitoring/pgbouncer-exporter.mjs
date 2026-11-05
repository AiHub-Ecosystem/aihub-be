import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { Gauge, Registry } from '@prometheus-io/client';
import { Pool } from 'pg';

const CLIENT_STATES = ['active', 'idle', 'waiting', 'login', 'other'];
const BACKEND_STATES = ['active', 'idle', 'used', 'tested', 'login'];

/** @typedef {{readonly database: string, readonly state: string, readonly count: number}} StateSample */
/** @typedef {{readonly database: string, readonly count: number}} WaitingSample */
/** @typedef {{readonly database: string, readonly seconds: number}} WaitSample */
/** @typedef {{readonly clients: readonly StateSample[], readonly backends: readonly StateSample[], readonly waiting: readonly WaitingSample[], readonly maxWait: readonly WaitSample[]}} PgBouncerAggregate */
/** @typedef {{readonly host: string, readonly port: number, readonly database: string, readonly user: string, readonly password: string}} MetricsCredentials */

/** @param {string} config @returns {string[]} */
export function databaseAliases(config) {
  const aliases = [];
  let inDatabases = false;
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[([^\]]+)\]$/)?.[1];
    if (section !== undefined) {
      inDatabases = section === 'databases';
      continue;
    }
    if (!inDatabases || trimmed.length === 0 || /^[#;]/.test(trimmed)) continue;
    const alias = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.-]{0,62})\s*=/)?.[1];
    if (alias === undefined || alias === 'pgbouncer') {
      throw new Error('PgBouncer database config is invalid');
    }
    aliases.push(alias);
  }
  if (aliases.length < 4 || new Set(aliases).size !== aliases.length) {
    throw new Error('PgBouncer database aliases are invalid');
  }
  return aliases;
}

/**
 * @param {readonly Record<string, unknown>[]} clientRows
 * @param {readonly Record<string, unknown>[]} poolRows
 * @param {readonly string[]} aliases
 * @returns {PgBouncerAggregate}
 */
export function aggregatePgbouncerRows(clientRows, poolRows, aliases) {
  const allowed = new Set(aliases);
  /** @type {Map<string, number>} */
  const clients = new Map();
  /** @type {Map<string, number>} */
  const backends = new Map();
  const waiting = new Map(aliases.map((alias) => [alias, 0]));
  const maxWait = new Map(aliases.map((alias) => [alias, 0]));

  for (const alias of aliases) {
    for (const state of CLIENT_STATES) clients.set(`${alias}:${state}`, 0);
    for (const state of BACKEND_STATES) backends.set(`${alias}:${state}`, 0);
  }

  for (const row of clientRows) {
    if (typeof row.database !== 'string' || !allowed.has(row.database))
      continue;
    const rawState = row.state;
    const state =
      typeof rawState === 'string' && CLIENT_STATES.includes(rawState)
        ? rawState
        : rawState === 'active_cancel_req'
          ? 'active'
          : rawState === 'waiting_cancel_req'
            ? 'waiting'
            : 'other';
    increment(clients, `${row.database}:${state}`);
  }

  for (const row of poolRows) {
    if (typeof row.database !== 'string' || !allowed.has(row.database))
      continue;
    for (const state of BACKEND_STATES) {
      increment(
        backends,
        `${row.database}:${state}`,
        nonNegativeNumber(row[`sv_${state}`]),
      );
    }
    waiting.set(
      row.database,
      (waiting.get(row.database) ?? 0) + nonNegativeNumber(row.cl_waiting),
    );
    maxWait.set(
      row.database,
      Math.max(maxWait.get(row.database) ?? 0, nonNegativeNumber(row.maxwait)),
    );
  }

  return {
    clients: [...clients].map(([key, count]) => {
      const [database, state] = key.split(':');
      return { database, state, count };
    }),
    backends: [...backends].map(([key, count]) => {
      const [database, state] = key.split(':');
      return { database, state, count };
    }),
    waiting: [...waiting].map(([database, count]) => ({ database, count })),
    maxWait: [...maxWait].map(([database, seconds]) => ({ database, seconds })),
  };
}

/** @param {Map<string, number>} map @param {string} key @param {number} [amount] */
function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** @param {unknown} value @returns {number} */
function nonNegativeNumber(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('PgBouncer returned an invalid metric value');
  }
  return number;
}

/** @returns {{readonly credentials: MetricsCredentials, readonly aliases: string[]}} */
function readConfiguration() {
  const credentialsPath = process.env.AIHUB_PGBOUNCER_METRICS_CREDENTIALS_FILE;
  const configPath = process.env.AIHUB_PGBOUNCER_CONFIG_FILE;
  if (!credentialsPath || !configPath) {
    throw new Error('PgBouncer metrics configuration is missing');
  }
  /** @type {unknown} */
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  if (
    !isRecord(credentials) ||
    credentials.host !== 'pgbouncer' ||
    credentials.port !== 5432 ||
    credentials.database !== 'pgbouncer' ||
    credentials.user !== 'aihub_pgbouncer_metrics' ||
    typeof credentials.password !== 'string' ||
    credentials.password.length === 0
  ) {
    throw new Error('PgBouncer metrics credentials are invalid');
  }
  const metricsCredentials = {
    host: 'pgbouncer',
    port: 5432,
    database: 'pgbouncer',
    user: 'aihub_pgbouncer_metrics',
    password: credentials.password,
  };
  return {
    credentials: metricsCredentials,
    aliases: databaseAliases(readFileSync(configPath, 'utf8')),
  };
}

/** @param {Registry} registry */
function createMetrics(registry) {
  const clients = new Gauge({
    name: 'aihub_pgbouncer_client_connections',
    help: 'Client connections accepted by PgBouncer, by alias and state.',
    labelNames: ['database', 'state'],
    registers: [registry],
  });
  const backends = new Gauge({
    name: 'aihub_pgbouncer_backend_connections',
    help: 'PostgreSQL backend connections held by PgBouncer, by alias and state.',
    labelNames: ['database', 'state'],
    registers: [registry],
  });
  const waiting = new Gauge({
    name: 'aihub_pgbouncer_waiting_clients',
    help: 'PgBouncer clients waiting for a PostgreSQL backend by alias.',
    labelNames: ['database'],
    registers: [registry],
  });
  const maxWait = new Gauge({
    name: 'aihub_pgbouncer_client_max_wait_seconds',
    help: 'Longest observed PgBouncer client wait by alias, in seconds.',
    labelNames: ['database'],
    registers: [registry],
  });
  const success = new Gauge({
    name: 'aihub_pgbouncer_scrape_success',
    help: 'Whether the last PgBouncer administrative scrape succeeded.',
    registers: [registry],
  });

  return {
    reset() {
      clients.reset();
      backends.reset();
      waiting.reset();
      maxWait.reset();
    },
    success,
    /** @param {PgBouncerAggregate} samples */
    set(samples) {
      for (const sample of samples.clients) {
        clients.set(
          { database: sample.database, state: sample.state },
          sample.count,
        );
      }
      for (const sample of samples.backends) {
        backends.set(
          { database: sample.database, state: sample.state },
          sample.count,
        );
      }
      for (const sample of samples.waiting) {
        waiting.set({ database: sample.database }, sample.count);
      }
      for (const sample of samples.maxWait) {
        maxWait.set({ database: sample.database }, sample.seconds);
      }
    },
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {Pool} pool @param {string[]} aliases */
export function createExporter(pool, aliases) {
  const registry = new Registry();
  const metrics = createMetrics(registry);
  /** @type {Promise<void> | undefined} */
  let inFlight;

  const collect = () => {
    inFlight ??= (async () => {
      const [clients, pools] = await Promise.all([
        pool.query('SHOW CLIENTS'),
        pool.query('SHOW POOLS'),
      ]);
      metrics.reset();
      metrics.set(aggregatePgbouncerRows(clients.rows, pools.rows, aliases));
      metrics.success.set(1);
    })()
      .catch((error) => {
        metrics.reset();
        metrics.success.set(0);
        throw error;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200).end('ok');
      return;
    }
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      try {
        await collect();
        response
          .writeHead(200, { 'content-type': registry.contentType })
          .end(await registry.metrics());
      } catch {
        response.writeHead(503).end();
      }
    })();
  });

  return { server, pool };
}

async function main() {
  const { credentials, aliases } = readConfiguration();
  const pool = new Pool({
    ...credentials,
    max: 1,
    connectionTimeoutMillis: 750,
    query_timeout: 750,
    statement_timeout: 500,
  });
  const port = Number(process.env.AIHUB_PGBOUNCER_METRICS_PORT ?? '9188');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PgBouncer metrics port is invalid');
  }
  const { server } = createExporter(pool, aliases);
  server.listen(port, '0.0.0.0');
  const shutdown = () => {
    server.close(() => void pool.end());
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write('PgBouncer metrics exporter failed to start\n');
    process.exitCode = 1;
  });
}

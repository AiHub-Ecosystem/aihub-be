import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  assertSafeDatabaseUrl,
  parseOptions,
  shouldContinueConsuming,
  summarize,
} from './runner-utils.mjs';

/** @typedef {'polling-table' | 'logical-message'} ScenarioMode */
/** @typedef {{events: number, rate: number, concurrency: number}} RunOptions */

/** @template {import('pg').QueryResultRow} Row @param {Pool} pool @param {import('pg').QueryConfig<Row>} config @returns {Promise<import('pg').QueryResult<Row>>} */
function query(pool, config) {
  return pool.query(config);
}
function cpuTimes() {
  return os.cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total:
        sum.total +
        Object.values(cpu.times).reduce((total, time) => total + time, 0),
    }),
    { idle: 0, total: 0 },
  );
}

// shortcut: host-wide CPU is not PostgreSQL-attributed; use container metrics for capacity decisions.
function watchHostCpu() {
  /** @type {number[]} */
  const samples = [];
  let previous = cpuTimes();
  const sample = () => {
    const current = cpuTimes();
    const total = current.total - previous.total;
    samples.push(
      total > 0 ? 100 * (1 - (current.idle - previous.idle) / total) : 0,
    );
    previous = current;
  };
  const timer = setInterval(sample, 1_000);
  return () => {
    clearInterval(timer);
    sample();
    return {
      averagePercent: samples.length
        ? samples.reduce((sum, value) => sum + value, 0) / samples.length
        : null,
      maxPercent: samples.length ? Math.max(...samples) : null,
    };
  };
}

/** @param {Pool} pool @param {ScenarioMode} mode @param {string} table @param {string} payload */
async function commitEvent(pool, mode, table, payload) {
  const started = performance.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (mode === 'polling-table') {
      await client.query(`INSERT INTO ${table} (payload) VALUES ($1)`, [
        payload,
      ]);
    } else {
      await client.query(
        "SELECT pg_logical_emit_message(true, 'aihub_outbox', $1)",
        [payload],
      );
    }
    await client.query('COMMIT');
    return performance.now() - started;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** @param {Pool} pool @param {ScenarioMode} mode @param {string} table @param {string} tableName @param {string | undefined} slot @param {RunOptions} options */
async function runScenario(
  pool,
  mode,
  table,
  tableName,
  slot,
  { events, rate, concurrency },
) {
  let consumed = 0;
  let stop = false;
  /** @type {unknown} */
  let consumerError;
  /** @type {number[]} */
  const latencies = [];
  const startLsn = (
    await query(
      pool,
      /** @type {import('pg').QueryConfig<{lsn: string}>} */ ({
        text: 'SELECT pg_current_wal_lsn() AS lsn',
      }),
    )
  ).rows[0].lsn;
  const start = performance.now();
  const hostCpu = watchHostCpu();
  let consumer;
  try {
    const consume = async () => {
      while (shouldContinueConsuming(stop, consumed, events)) {
        try {
          if (mode === 'polling-table') {
            const result = await pool.query(
              `WITH claimed AS (
               SELECT id FROM ${table} ORDER BY id LIMIT 128 FOR UPDATE SKIP LOCKED
             ) DELETE FROM ${table} AS event USING claimed WHERE event.id = claimed.id`,
            );
            consumed += result.rowCount ?? 0;
          } else {
            const result = await query(
              pool,
              /** @type {import('pg').QueryConfig<{data: string | null}>} */ ({
                text: 'SELECT data FROM pg_logical_slot_get_changes($1, NULL, 1_000)',
                values: [slot ?? ''],
              }),
            );
            const rows = /** @type {unknown[]} */ (result.rows);
            consumed += rows.filter(
              (row) =>
                typeof row === 'object' &&
                row !== null &&
                'data' in row &&
                typeof row.data === 'string' &&
                row.data.includes('prefix: aihub_outbox'),
            ).length;
          }
          if (consumed < events) await delay(5);
        } catch (error) {
          consumerError = error;
          stop = true;
          return;
        }
      }
    };
    consumer = consume();
    /** @type {Set<Promise<number>>} */
    const pending = new Set();
    let produced = 0;
    let productionDurationMs = 0;
    while (produced < events) {
      if (consumerError) throw consumerError;
      if (pending.size >= concurrency) await Promise.race(pending);
      const due = start + (produced * 1_000) / rate;
      if (due > performance.now()) await delay(due - performance.now());
      const payload = JSON.stringify({
        id: produced + 1,
        event: 'grading.completed',
        padding: 'x'.repeat(192),
      });
      let task = /** @type {Promise<number>} */ (Promise.resolve(0));
      task = commitEvent(pool, mode, table, payload)
        .then((latency) => {
          latencies.push(latency);
          return latency;
        })
        .finally(() => pending.delete(task));
      pending.add(task);
      produced += 1;
    }
    await Promise.all(pending);
    productionDurationMs = performance.now() - start;
    const drainDeadline = Date.now() + 120_000;
    while (consumed < events && !consumerError && Date.now() < drainDeadline)
      await delay(50);
    if (consumerError) throw consumerError;
    if (consumed !== events)
      throw new Error(
        `${mode} consumed ${consumed} of ${events} events before timeout`,
      );
    const elapsedMs = performance.now() - start;
    const endLsn = (
      await query(
        pool,
        /** @type {import('pg').QueryConfig<{lsn: string}>} */ ({
          text: 'SELECT pg_current_wal_lsn() AS lsn',
        }),
      )
    ).rows[0].lsn;
    const walBytes = Number(
      (
        await query(
          pool,
          /** @type {import('pg').QueryConfig<{bytes: string}>} */ ({
            text: 'SELECT pg_wal_lsn_diff($1, $2) AS bytes',
            values: [endLsn, startLsn],
          }),
        )
      ).rows[0].bytes,
    );
    const tableStats =
      mode === 'polling-table'
        ? (
            await query(
              pool,
              /** @type {import('pg').QueryConfig<{n_dead_tup: string | number, relation_bytes: string}>} */ ({
                text: 'SELECT n_dead_tup, pg_total_relation_size($1::regclass) AS relation_bytes FROM pg_stat_user_tables WHERE relname = $1::text',
                values: [tableName],
              }),
            )
          ).rows[0]
        : undefined;
    return {
      mode,
      events: consumed,
      targetEventsPerSecond: rate,
      committedEventsPerSecond: Number(
        ((produced * 1_000) / productionDurationMs).toFixed(1),
      ),
      productionDurationMs: Number(productionDurationMs.toFixed(1)),
      endToEndDurationMs: Number(elapsedMs.toFixed(1)),
      drainDurationMs: Number((elapsedMs - productionDurationMs).toFixed(1)),
      commitLatencyMs: summarize(
        latencies.map((value) => Number(value.toFixed(3))),
      ),
      walBytes,
      walBytesPerSecond: Number(((walBytes * 1_000) / elapsedMs).toFixed(1)),
      walBytesPerEvent: Number((walBytes / consumed).toFixed(1)),
      deadTupleEstimate: tableStats ? Number(tableStats.n_dead_tup) : null,
      relationBytes: tableStats ? Number(tableStats.relation_bytes) : null,
      hostCpuPercent: hostCpu(),
    };
  } finally {
    stop = true;
    await consumer;
    hostCpu();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.AIHUB_OUTBOX_EVAL_DATABASE_URL;
  if (!connectionString)
    throw new Error(
      'Set AIHUB_OUTBOX_EVAL_DATABASE_URL to the isolated local database',
    );
  assertSafeDatabaseUrl(connectionString);
  const pool = new Pool({
    connectionString,
    max: options.concurrency + 2,
    application_name: 'aihub-zero-table-outbox-eval',
  });
  const suffix = randomUUID().replaceAll('-', '');
  const tableName = `aihub_outbox_eval_${suffix}`;
  const table = `"${tableName}"`;
  const slot = `aihub_outbox_eval_${suffix}`;
  let slotCreated = false;
  try {
    const { rows: settings } = await query(
      pool,
      /** @type {import('pg').QueryConfig<{wal_level: string, database: string}>} */ ({
        text: "SELECT current_setting('wal_level') AS wal_level, current_database() AS database",
      }),
    );
    if (
      settings[0].database !== 'aihub_outbox_eval' ||
      settings[0].wal_level !== 'logical'
    ) {
      throw new Error(
        'Requires database aihub_outbox_eval with wal_level=logical',
      );
    }
    await pool.query(
      `CREATE TABLE ${table} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload text NOT NULL)`,
    );
    const polling = await runScenario(
      pool,
      'polling-table',
      table,
      tableName,
      undefined,
      options,
    );
    await query(pool, {
      text: 'SELECT pg_create_logical_replication_slot($1, $2)',
      values: [slot, 'test_decoding'],
    });
    slotCreated = true;
    const logical = await runScenario(
      pool,
      'logical-message',
      table,
      tableName,
      slot,
      options,
    );
    const { rows: versionRows } = await query(
      pool,
      /** @type {import('pg').QueryConfig<{server_version: string}>} */ ({
        text: 'SHOW server_version',
      }),
    );
    process.stdout.write(
      `${JSON.stringify({ postgresVersion: versionRows[0].server_version, options, results: [polling, logical] }, null, 2)}\n`,
    );
  } finally {
    if (slotCreated)
      await query(pool, {
        text: 'SELECT pg_drop_replication_slot($1)',
        values: [slot],
      }).catch(() => undefined);
    await query(pool, { text: `DROP TABLE IF EXISTS ${table}` }).catch(
      () => undefined,
    );
    await pool.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

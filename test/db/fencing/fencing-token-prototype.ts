import { Pool } from 'pg';

export const PROTOTYPE_SCHEMA = 'issue1055_fencing';
export const PROTOTYPE_LEASE_TTL_MS = 1_000;
const PAUSED_WORKER_MS = 5_000;

const ACQUIRE_LEASE_SQL = `
  INSERT INTO ${PROTOTYPE_SCHEMA}.leases (
    resource_id, owner_id, lease_expires_at, fencing_token
  )
  VALUES (
    $1, $2,
    clock_timestamp() + ($3::int * interval '1 millisecond'),
    1
  )
  ON CONFLICT (resource_id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    lease_expires_at = EXCLUDED.lease_expires_at,
    fencing_token = ${PROTOTYPE_SCHEMA}.leases.fencing_token + 1
  WHERE ${PROTOTYPE_SCHEMA}.leases.lease_expires_at <= clock_timestamp()
  RETURNING fencing_token::text
`;

export async function createFencingPrototype(
  pool: Pool,
  resourceId: string,
): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${PROTOTYPE_SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${PROTOTYPE_SCHEMA}`);
  await pool.query(`
    CREATE TABLE ${PROTOTYPE_SCHEMA}.leases (
      resource_id text PRIMARY KEY,
      owner_id text NOT NULL,
      lease_expires_at timestamptz NOT NULL,
      fencing_token bigint NOT NULL CHECK (fencing_token > 0)
    )
  `);
  await pool.query(`
    CREATE TABLE ${PROTOTYPE_SCHEMA}.protected_records (
      resource_id text PRIMARY KEY,
      value text NOT NULL,
      fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0)
    )
  `);
  await pool.query(
    `INSERT INTO ${PROTOTYPE_SCHEMA}.protected_records (resource_id, value)
     VALUES ($1, 'initial')`,
    [resourceId],
  );
}

export async function acquireFencingToken(
  pool: Pool,
  resourceId: string,
  ownerId: string,
  leaseMs: number,
): Promise<string | undefined> {
  const result = await pool.query<{ readonly fencing_token: string }>(
    ACQUIRE_LEASE_SQL,
    [resourceId, ownerId, leaseMs],
  );
  return result.rows[0]?.fencing_token;
}

export async function writeProtectedValue(
  pool: Pool,
  resourceId: string,
  value: string,
  fencingToken: string,
): Promise<number> {
  const result = await pool.query(
    `UPDATE ${PROTOTYPE_SCHEMA}.protected_records
     SET value = $2, fencing_token = $3::bigint
     WHERE resource_id = $1 AND fencing_token < $3::bigint`,
    [resourceId, value, fencingToken],
  );
  return result.rowCount ?? 0;
}

export async function readProtectedValue(
  pool: Pool,
  resourceId: string,
): Promise<{ readonly value: string; readonly fencingToken: string }> {
  const result = await pool.query<{
    readonly value: string;
    readonly fencing_token: string;
  }>(
    `SELECT value, fencing_token::text
     FROM ${PROTOTYPE_SCHEMA}.protected_records
     WHERE resource_id = $1`,
    [resourceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('prototype resource is missing');
  return { value: row.value, fencingToken: row.fencing_token };
}

async function runPausedWorker(resourceId: string): Promise<void> {
  const connectionString = process.env['FENCING_TEST_DATABASE_URL'];
  if (connectionString === undefined) {
    throw new Error('fencing test database is not configured');
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const ownerId = 'worker-a';
    const fencingToken = await acquireFencingToken(
      pool,
      resourceId,
      ownerId,
      PROTOTYPE_LEASE_TTL_MS,
    );
    if (fencingToken === undefined) throw new Error('initial lease was denied');
    process.send?.({ type: 'acquired', token: fencingToken });

    const leaseLost = new AbortController();
    let localWorkJoined = false;
    let subsequentSideEffects = 0;
    const localWork = (async () => {
      try {
        await new Promise<void>((resolve) => {
          leaseLost.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        leaseLost.signal.throwIfAborted();
        subsequentSideEffects += 1;
      } finally {
        await Promise.resolve();
        localWorkJoined = true;
      }
    })();

    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      0,
      0,
      PAUSED_WORKER_MS,
    );

    const staleWriteRows = await writeProtectedValue(
      pool,
      resourceId,
      'stale-worker-a',
      fencingToken,
    );
    const current = await pool.query<{
      readonly owner_id: string;
      readonly fencing_token: string;
      readonly lease_is_live: boolean;
    }>(
      `SELECT owner_id, fencing_token::text,
              lease_expires_at > clock_timestamp() AS lease_is_live
       FROM ${PROTOTYPE_SCHEMA}.leases
       WHERE resource_id = $1`,
      [resourceId],
    );
    const lease = current.rows[0];
    const leaseLostDetected =
      lease === undefined ||
      lease.owner_id !== ownerId ||
      lease.fencing_token !== fencingToken ||
      !lease.lease_is_live;
    if (leaseLostDetected) leaseLost.abort(new Error('lease lost'));

    let cancelled = false;
    try {
      await localWork;
    } catch {
      cancelled = leaseLost.signal.aborted;
    }

    process.send?.({
      type: 'settled',
      leaseLostDetected,
      currentOwner: lease?.owner_id ?? null,
      currentToken: lease?.fencing_token ?? null,
      staleWriteRows,
      cancelled,
      localWorkJoined,
      subsequentSideEffects,
    });
  } finally {
    await pool.end();
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

if (process.argv[2] === '--paused-worker') {
  void runPausedWorker(process.argv[3] ?? '').then(
    () => process.disconnect?.(),
    (error: unknown) => {
      process.send?.({ type: 'failure', errorCode: errorCode(error) });
      process.exitCode = 1;
      process.disconnect?.();
    },
  );
}

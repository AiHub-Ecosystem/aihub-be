export const POSTGRES_LANE_OWNERSHIP_SETTING =
  'aihub.test_lane_marker=aihub_db_lane_v1';
export const REDIS_LANE_OWNERSHIP_MARKER_KEY = 'aihub:test-lane:owner';
export const REDIS_LANE_OWNERSHIP_MARKER = 'aihub-db-lane-v1';

export interface PostgresOwnershipClient {
  query(
    text: string,
    values: string[],
  ): Promise<{ rows: Array<{ owned: boolean }> }>;
}

export async function withOwnedPostgresServer<T>(
  isOwned: () => Promise<boolean>,
  operation: () => Promise<T>,
): Promise<T> {
  let owned = false;
  try {
    owned = await isOwned();
  } catch {
    // A failed ownership check must fail closed before the lane changes data.
  }

  if (!owned) {
    throw new Error(
      'DB_LANE_ADMIN_URL does not point to an AIHUB-owned PostgreSQL service; refusing to create or drop lane databases.',
    );
  }

  return operation();
}

export function withOwnedPostgresDatabase<T>(
  admin: PostgresOwnershipClient,
  databaseName: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withOwnedPostgresServer(async () => {
    const ownership = await admin.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_db_role_setting AS settings
         JOIN pg_database AS db
           ON db.oid = settings.setdatabase
         WHERE db.datname = $1
           AND settings.setrole = 0
           AND settings.setconfig @> ARRAY[$2]
       ) AS owned`,
      [databaseName, POSTGRES_LANE_OWNERSHIP_SETTING],
    );
    return ownership.rows[0]?.owned === true;
  }, operation);
}

export interface RedisOwnershipClient {
  get(key: string): Promise<string | null>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  quit(): Promise<unknown>;
}

export async function flushOwnedRedisDatabase(
  owner: RedisOwnershipClient,
  flush: () => Promise<unknown>,
  settingName: string,
): Promise<void> {
  owner.on('error', () => undefined);
  try {
    let marker: string | null;
    try {
      marker = await owner.get(REDIS_LANE_OWNERSHIP_MARKER_KEY);
    } catch {
      throw new Error(
        `Refusing to FLUSHDB: cannot verify the Redis ownership marker for ${settingName}.`,
      );
    }
    if (marker !== REDIS_LANE_OWNERSHIP_MARKER) {
      throw new Error(
        `Refusing to FLUSHDB: ${settingName} does not point to an AIHUB-owned Redis service.`,
      );
    }
    await flush();
  } finally {
    await owner.quit().catch(() => undefined);
  }
}

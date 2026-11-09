import type {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  QueryResult,
} from 'kysely';
import type { Pool, PoolConfig } from 'pg';

/**
 * The dialect config type kysely does not re-export from its root entry
 * point: its `exports` map exposes only `.`, `./helpers/*`, `./migration` and
 * `./readonly`, so the deep `kysely/dist/...` path this file used to import is
 * outside the package's public surface. Deriving the type from the public
 * `PostgresDialect` constructor keeps the shape faithful without the deep
 * import.
 */
type PostgresDialectConfig = ConstructorParameters<typeof PostgresDialect>[0];

export interface BenchmarkRow {
  organization_id: string;
  quota: number;
  billable_count: bigint;
}

export interface KyselyBenchmarkModule {
  compileKyselyQuotaReconciliation: (
    database: Kysely<never>,
    from: Date,
    to: Date,
  ) => CompiledQuery<BenchmarkRow>;
  createKyselyQuotaClient: (
    pool: PostgresDialectConfig['pool'] | StubPool,
  ) => Kysely<never>;
}

export interface PrismaBenchmarkModule {
  QUOTA_RECONCILIATION_SQL: string;
}

export interface StubPool {
  connect(): Promise<{
    getTransactionStatus(): string | null;
    query(): Promise<QueryResult<BenchmarkRow>>;
    release(): void;
  }>;
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<QueryResult<BenchmarkRow>>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface DatabaseBenchmarkRow {
  organization_id: string;
  quota: number | null;
  billable_count: bigint;
}

export interface PgModule {
  Pool: new (config: PoolConfig) => Pool;
}

export interface PrismaAdapterModule {
  PrismaPg: new (pool: Pool) => object;
}

export interface PrismaClientModule {
  PrismaClient: new (options: {
    adapter: object;
  }) => {
    $queryRawUnsafe(
      sql: string,
      ...values: unknown[]
    ): Promise<readonly DatabaseBenchmarkRow[]>;
    $disconnect(): Promise<void>;
  };
}

export interface PostgresPoolModule {
  createPostgresPool: (name: string, config: PoolConfig) => Pool;
  postgresPoolOptions: (url: string, max: number) => PoolConfig;
}

export interface DatabaseQueryResult {
  rows: DatabaseBenchmarkRow[];
}

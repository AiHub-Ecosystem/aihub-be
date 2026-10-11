import { createPrismaClient } from '@/modules/persistence/persistence.module';

/** Test-only query client for the unchanged idempotency database spec. */
export interface PostgresIdempotencyClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
  close(): Promise<void>;
}

export interface PrismaIdempotencyClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  close(): Promise<void>;
}

export function createPostgresIdempotencyClient(
  databaseUrl: string,
): PrismaIdempotencyClient {
  if (databaseUrl.trim().length === 0) {
    return {
      $queryRawUnsafe: async () => {
        throw new Error('DATABASE_URL is missing');
      },
      close: async () => undefined,
    };
  }

  const holder = createPrismaClient('integration-test', databaseUrl);

  return {
    $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) =>
      holder.prisma.$queryRawUnsafe<T>(query, ...values),
    close: holder.close,
  };
}

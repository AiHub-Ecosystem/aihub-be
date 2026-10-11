import {
  isRowlessWrite,
  normalizeRawRows,
  postgresError,
  runGuardedTransaction,
} from '@/modules/persistence/persistence.module';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type { Prisma, PrismaClient } from '@prisma-client/client';

export type AuthRepositoryClient = PrismaClient;
export type AuthSqlClient = Prisma.TransactionClient | PrismaClient;
export type AuthTransactionClient = Prisma.TransactionClient;

/**
 * Raw row types stay explicit at Prisma's untyped SQL boundary. The promise is
 * observed at once so a statement the caller never awaits cannot become an
 * unhandled rejection; the transaction guard still sees its failure.
 */
export function authQueryRows<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  client: AuthSqlClient,
  text: string,
  values: readonly unknown[],
): Promise<readonly T[]> {
  const query = isRowlessWrite(text)
    ? client.$executeRawUnsafe(text, ...values).then(() => [] as readonly T[])
    : client
        .$queryRawUnsafe<readonly T[]>(text, ...values)
        .then(normalizeRawRows);
  const translated = query.catch((error) => {
    throw postgresError(error);
  });
  void translated.catch(() => undefined);
  return translated;
}

export function authExecute(
  client: AuthSqlClient,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  const query = client
    .$executeRawUnsafe(text, ...values)
    .then(() => undefined)
    .catch((error) => {
      throw postgresError(error);
    });
  void query.catch(() => undefined);
  return query;
}

export function authTransaction<T>(
  client: AuthRepositoryClient,
  callback: (transaction: AuthTransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    (transaction) =>
      runGuardedTransaction(transaction, callback, {
        expired: () => new Error('Auth transaction is no longer active'),
        mapFailure: postgresError,
      }),
    CONTROL_PLANE_TRANSACTION_OPTIONS,
  );
}

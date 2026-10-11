import type { PrismaClient } from '@prisma-client/client';

export interface PostgresTransactionClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]>;
}

export interface PostgresMeteringClient extends PostgresTransactionClient {
  transaction<T>(
    callback: (client: PostgresTransactionClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

type PrismaRawQueryClient = Pick<PrismaClient, '$queryRawUnsafe'>;

function queryRows<Row extends object>(
  client: PrismaRawQueryClient,
  text: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  return client.$queryRawUnsafe<readonly Row[]>(text, ...values);
}

export function createPrismaMeteringClient(
  getPrisma: () => PrismaClient,
  close: () => Promise<void> = async () => undefined,
): PostgresMeteringClient {
  return {
    query: <Row extends object = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => queryRows<Row>(getPrisma(), text, values),
    transaction: (callback) =>
      getPrisma().$transaction((transaction) =>
        callback({
          query: <Row extends object = Record<string, unknown>>(
            text: string,
            values: readonly unknown[],
          ) => queryRows<Row>(transaction, text, values),
        }),
      ),
    close,
  };
}

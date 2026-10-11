import type { PrismaClient } from '@prisma-client/client';

import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';

export interface SandboxDispatchBudgetTransactionClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]>;
  execute(text: string, values: readonly unknown[]): Promise<number>;
}

export interface SandboxDispatchBudgetClient
  extends SandboxDispatchBudgetTransactionClient {
  transaction<T>(
    callback: (client: SandboxDispatchBudgetTransactionClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

type PrismaRawClient = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$executeRawUnsafe'
>;

function executor(
  client: PrismaRawClient,
): SandboxDispatchBudgetTransactionClient {
  return {
    query: <Row extends object = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => client.$queryRawUnsafe<readonly Row[]>(text, ...values),
    execute: (text, values) => client.$executeRawUnsafe(text, ...values),
  };
}

export function createPrismaSandboxDispatchBudgetClient(
  getPrisma: () => PrismaClient,
  close: () => Promise<void> = async () => undefined,
): SandboxDispatchBudgetClient {
  return {
    query: <Row extends object = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => getPrisma().$queryRawUnsafe<readonly Row[]>(text, ...values),
    execute: (text, values) => getPrisma().$executeRawUnsafe(text, ...values),
    transaction: (callback) =>
      getPrisma().$transaction(
        (transaction) => callback(executor(transaction)),
        CONTROL_PLANE_TRANSACTION_OPTIONS,
      ),
    close,
  };
}

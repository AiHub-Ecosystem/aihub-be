import type { PrismaClient } from '@prisma-client/client';

export interface SpeakingAudioTransactionClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]>;
  execute(text: string, values: readonly unknown[]): Promise<number>;
}

export interface SpeakingAudioQueryClient
  extends SpeakingAudioTransactionClient {
  transaction<T>(
    callback: (client: SpeakingAudioTransactionClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

type PrismaRawQueryClient = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$executeRawUnsafe'
>;

function executor(
  client: PrismaRawQueryClient,
): SpeakingAudioTransactionClient {
  return {
    query: <Row extends object = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => client.$queryRawUnsafe<readonly Row[]>(text, ...values),
    execute: (text, values) => client.$executeRawUnsafe(text, ...values),
  };
}

export function createPrismaSpeakingAudioQueryClient(
  getPrisma: () => PrismaClient,
  close: () => Promise<void> = async () => undefined,
): SpeakingAudioQueryClient {
  return {
    query: <Row extends object = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => getPrisma().$queryRawUnsafe<readonly Row[]>(text, ...values),
    execute: (text, values) => getPrisma().$executeRawUnsafe(text, ...values),
    transaction: (callback) =>
      getPrisma().$transaction((transaction) =>
        callback(executor(transaction)),
      ),
    close,
  };
}

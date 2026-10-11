import type { PrismaClient } from '@prisma-client/client';

type PrismaRawQueryClient = Pick<PrismaClient, '$queryRawUnsafe'>;

export interface AvatarQueryClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]>;
  close(): Promise<void>;
}

export function createPrismaAvatarQueryClient(
  getPrisma: () => PrismaRawQueryClient,
  close: () => Promise<void> = async () => undefined,
): AvatarQueryClient {
  return {
    query: <Row extends object = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => getPrisma().$queryRawUnsafe<readonly Row[]>(text, ...values),
    close,
  };
}

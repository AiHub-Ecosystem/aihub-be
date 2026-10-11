import type {
  SandboxDispatchBudgetPort,
  SandboxDispatchReservation,
} from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type { PrismaClient } from '@prisma-client/client';
import { createPostgresSandboxDispatchBudgetClient } from './postgres-sandbox-dispatch-budget.fixture-client';

export const SANDBOX_ENVIRONMENT_MONTHLY_LIMIT = 500;

export class PostgresSandboxDispatchBudget
  implements SandboxDispatchBudgetPort
{
  private readonly client: PrismaClient & { close?: () => Promise<void> };

  constructor(
    clientOrDatabaseUrl:
      | (PrismaClient & { close?: () => Promise<void> })
      | string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.client =
      typeof clientOrDatabaseUrl === 'string'
        ? createPostgresSandboxDispatchBudgetClient(clientOrDatabaseUrl)
        : clientOrDatabaseUrl;
  }

  async reserve(input: SandboxDispatchReservation): Promise<boolean> {
    const now = this.now();
    const month = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1;
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    return this.client.$transaction(async (transaction) => {
      // ponytail: one lock per UTC month serializes the 500/month admission check; split by Organization if dispatch volume makes this a bottleneck.
      // Prisma's query path cannot deserialize PostgreSQL's void result.
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock($1, $2)',
        182,
        month,
      );

      // Both counts run under the month's advisory lock, so no reservation
      // lands between them.
      const reserved = { status: 'reserved', monthStart } as const;
      const organizationCount =
        await transaction.sandboxDispatchReservation.count({
          where: { ...reserved, organizationId: input.organizationId },
        });
      const environmentCount =
        await transaction.sandboxDispatchReservation.count({ where: reserved });
      if (
        (input.organizationLimit !== null &&
          organizationCount >= input.organizationLimit) ||
        environmentCount >= SANDBOX_ENVIRONMENT_MONTHLY_LIMIT
      ) {
        return false;
      }

      await transaction.sandboxDispatchReservation.create({
        data: {
          requestId: input.requestId,
          organizationId: input.organizationId,
          monthStart,
          createdAt: now,
        },
      });
      return true;
    }, CONTROL_PLANE_TRANSACTION_OPTIONS);
  }

  async release(requestId: string): Promise<void> {
    await this.client.sandboxDispatchReservation.updateMany({
      where: { requestId, status: 'reserved' },
      data: { status: 'released', releasedAt: this.now() },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close?.();
  }
}

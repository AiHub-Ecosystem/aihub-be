import { effectiveSandboxAllowance } from '@/modules/gateway/application/effective-sandbox-allowance';
import type {
  SandboxAllowanceSnapshot,
  SandboxDispatchBudgetPort,
  SandboxDispatchReservation,
} from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type { PrismaClient } from '@prisma-client/client';
import { createPostgresSandboxDispatchBudgetClient } from './postgres-sandbox-dispatch-budget.fixture-client';

export const SANDBOX_ENVIRONMENT_MONTHLY_LIMIT = 500;

interface AllowanceReader {
  sandboxAllowanceOverride: {
    findUnique(input: {
      where: {
        organizationId_monthStart: {
          organizationId: string;
          monthStart: Date;
        };
      };
    }): Promise<{ allowance: number } | null>;
  };
  sandboxAllowanceDefault: {
    findFirst(input: {
      where: { monthStart: { lte: Date } };
      orderBy: { monthStart: 'desc' };
    }): Promise<{ allowance: number } | null>;
  };
}

function utcMonth(now: Date): { month: number; monthStart: Date } {
  return {
    month: now.getUTCFullYear() * 100 + now.getUTCMonth() + 1,
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}

/**
 * A month-specific override replaces the persisted default for that month; a
 * month with no override falls back to the latest default at or before it.
 *
 * null means the policy is missing for this month, which is not the same as an
 * allowance of zero and is never treated as unlimited.
 */
async function effectiveAllowance(
  reader: AllowanceReader,
  organizationId: string,
  monthStart: Date,
): Promise<number | null> {
  const [override, persistedDefault] = await Promise.all([
    reader.sandboxAllowanceOverride.findUnique({
      where: { organizationId_monthStart: { organizationId, monthStart } },
    }),
    reader.sandboxAllowanceDefault.findFirst({
      where: { monthStart: { lte: monthStart } },
      orderBy: { monthStart: 'desc' },
    }),
  ]);
  return effectiveSandboxAllowance(
    override?.allowance ?? null,
    persistedDefault?.allowance ?? null,
  );
}

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
    const { month, monthStart } = utcMonth(now);

    return this.client.$transaction(async (transaction) => {
      // ponytail: one lock per UTC month serializes the 500/month admission check; split by Organization if dispatch volume makes this a bottleneck.
      // Prisma's query path cannot deserialize PostgreSQL's void result.
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock($1, $2)',
        182,
        month,
      );

      // Runbook policy edits take this same lock, so a lowering override cannot
      // race a reservation that has already read the older value.
      const monthlyLimit = await effectiveAllowance(
        transaction,
        input.organizationId,
        monthStart,
      );
      if (monthlyLimit === null) {
        throw new Error('Sandbox allowance policy is unavailable');
      }

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
        organizationCount >= monthlyLimit ||
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

  async allowanceFor(
    organizationId: string,
  ): Promise<SandboxAllowanceSnapshot | null> {
    const { monthStart } = utcMonth(this.now());
    try {
      const monthlyLimit = await effectiveAllowance(
        this.client,
        organizationId,
        monthStart,
      );
      if (monthlyLimit === null) return null;
      return {
        monthlyLimit,
        reserved: await this.client.sandboxDispatchReservation.count({
          where: { status: 'reserved', monthStart, organizationId },
        }),
      };
    } catch {
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close?.();
  }
}

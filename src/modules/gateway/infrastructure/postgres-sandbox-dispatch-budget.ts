import { quotaPeriod } from '@/modules/gateway/application/quota-period';
import {
  SANDBOX_ENVIRONMENT_MONTHLY_LIMIT,
  canReserveSandboxDispatch,
} from '@/modules/gateway/application/sandbox-dispatch-budget-policy';
import type {
  SandboxAllowanceSnapshot,
  SandboxDispatchBudgetPort,
  SandboxDispatchReservation,
} from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type { PrismaClient } from '@prisma-client/client';
import { createPostgresSandboxDispatchBudgetClient } from './postgres-sandbox-dispatch-budget.fixture-client';

type PersistenceClient = PrismaClient & { close?: () => Promise<void> };
type AllowanceReader = Pick<
  PrismaClient,
  'sandboxAllowanceOverride' | 'sandboxAllowanceDefault'
>;

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
  return override?.allowance ?? persistedDefault?.allowance ?? null;
}

export class PostgresSandboxDispatchBudget
  implements SandboxDispatchBudgetPort
{
  private readonly client: PersistenceClient;

  constructor(
    clientOrDatabaseUrl: PersistenceClient | string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.client =
      typeof clientOrDatabaseUrl === 'string'
        ? createPostgresSandboxDispatchBudgetClient(clientOrDatabaseUrl)
        : clientOrDatabaseUrl;
  }

  async reserve(input: SandboxDispatchReservation): Promise<boolean> {
    const now = this.now();
    const { monthNumber, start: monthStart } = quotaPeriod(now);

    return this.client.$transaction(async (transaction) => {
      // ponytail: one lock per UTC month serializes the 500/month admission check; split by Organization if dispatch volume makes this a bottleneck.
      // Prisma's query path cannot deserialize PostgreSQL's void result.
      await transaction.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock($1, $2)',
        182,
        monthNumber,
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
        !canReserveSandboxDispatch({
          organizationCount,
          organizationLimit: monthlyLimit,
          environmentCount,
        })
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
    const { start: monthStart } = quotaPeriod(this.now());
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
        sharedMonthlyLimit: SANDBOX_ENVIRONMENT_MONTHLY_LIMIT,
        sharedReserved: await this.client.sandboxDispatchReservation.count({
          where: { status: 'reserved', monthStart },
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

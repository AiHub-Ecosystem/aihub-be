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

      const counts = await transaction.$queryRawUnsafe<
        readonly DispatchCountRow[]
      >(
        `SELECT
           count(*) FILTER (WHERE organization_id = $1)::text AS organization_count,
           count(*)::text AS environment_count
         FROM sandbox_dispatch_reservations
         WHERE status = 'reserved'
           AND month_start = $2`,
        input.organizationId,
        monthStart,
      );
      const organizationCount = Number(counts[0]?.organization_count);
      const environmentCount = Number(counts[0]?.environment_count);
      if (
        (input.organizationLimit !== null &&
          organizationCount >= input.organizationLimit) ||
        environmentCount >= SANDBOX_ENVIRONMENT_MONTHLY_LIMIT
      ) {
        return false;
      }

      await transaction.$executeRawUnsafe(
        `INSERT INTO sandbox_dispatch_reservations
           (request_id, organization_id, month_start, created_at)
         VALUES ($1, $2, $3, $4)`,
        input.requestId,
        input.organizationId,
        monthStart,
        now,
      );
      return true;
    }, CONTROL_PLANE_TRANSACTION_OPTIONS);
  }

  async release(requestId: string): Promise<void> {
    await this.client.$executeRawUnsafe(
      `UPDATE sandbox_dispatch_reservations
       SET status = 'released', released_at = now()
       WHERE request_id = $1 AND status = 'reserved'`,
      requestId,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close?.();
  }
}

interface DispatchCountRow {
  readonly organization_count: string;
  readonly environment_count: string;
}

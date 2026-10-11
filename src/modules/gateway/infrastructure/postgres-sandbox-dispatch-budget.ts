import type {
  SandboxDispatchBudgetPort,
  SandboxDispatchReservation,
} from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import { createPostgresSandboxDispatchBudgetClient } from './postgres-sandbox-dispatch-budget.fixture-client';
import type { SandboxDispatchBudgetClient } from './prisma-sandbox-dispatch-budget.client';

export const SANDBOX_ENVIRONMENT_MONTHLY_LIMIT = 500;

export class PostgresSandboxDispatchBudget
  implements SandboxDispatchBudgetPort
{
  private readonly client: SandboxDispatchBudgetClient;

  constructor(
    clientOrDatabaseUrl: SandboxDispatchBudgetClient | string,
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

    return this.client.transaction(async (transaction) => {
      // ponytail: one lock per UTC month serializes the 500/month admission check; split by Organization if dispatch volume makes this a bottleneck.
      // Prisma's query path cannot deserialize PostgreSQL's void result.
      await transaction.execute('SELECT pg_advisory_xact_lock($1, $2)', [
        182,
        month,
      ]);

      const counts = await transaction.query<DispatchCountRow>(
        `SELECT
           count(*) FILTER (WHERE organization_id = $1)::text AS organization_count,
           count(*)::text AS environment_count
         FROM sandbox_dispatch_reservations
         WHERE status = 'reserved'
           AND month_start = $2`,
        [input.organizationId, monthStart],
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

      await transaction.execute(
        `INSERT INTO sandbox_dispatch_reservations
           (request_id, organization_id, month_start, created_at)
         VALUES ($1, $2, $3, $4)`,
        [input.requestId, input.organizationId, monthStart, now],
      );
      return true;
    });
  }

  async release(requestId: string): Promise<void> {
    await this.client.execute(
      `UPDATE sandbox_dispatch_reservations
       SET status = 'released', released_at = now()
       WHERE request_id = $1 AND status = 'reserved'`,
      [requestId],
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}

interface DispatchCountRow {
  readonly organization_count: string;
  readonly environment_count: string;
}

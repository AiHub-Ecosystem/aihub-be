import { Pool } from 'pg';

import type {
  SandboxDispatchBudgetPort,
  SandboxDispatchReservation,
} from '@/modules/gateway/application/sandbox-dispatch-budget.port';

export const SANDBOX_ENVIRONMENT_MONTHLY_LIMIT = 500;

export class PostgresSandboxDispatchBudget
  implements SandboxDispatchBudgetPort
{
  private readonly pool?: Pool;

  constructor(
    databaseUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (databaseUrl.trim().length > 0) {
      this.pool = new Pool({
        connectionString: databaseUrl,
        max: 4,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 30_000,
      });
    }
  }

  async reserve(input: SandboxDispatchReservation): Promise<boolean> {
    if (this.pool === undefined) {
      throw new Error('Sandbox dispatch budget database is unavailable');
    }

    const now = this.now();
    const month = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1;
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // ponytail: one lock per UTC month serializes the 500/month admission check; split by Organization if dispatch volume makes this a bottleneck.
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [182, month]);

      const counts = await client.query<{
        organization_count: string;
        environment_count: string;
      }>(
        `SELECT
           count(*) FILTER (WHERE organization_id = $1)::text AS organization_count,
           count(*)::text AS environment_count
         FROM sandbox_dispatch_reservations
         WHERE status = 'reserved'
           AND month_start = $2`,
        [input.organizationId, monthStart],
      );
      const organizationCount = Number(counts.rows[0]?.organization_count);
      const environmentCount = Number(counts.rows[0]?.environment_count);
      if (
        (input.organizationLimit !== null &&
          organizationCount >= input.organizationLimit) ||
        environmentCount >= SANDBOX_ENVIRONMENT_MONTHLY_LIMIT
      ) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `INSERT INTO sandbox_dispatch_reservations
           (request_id, organization_id, month_start, created_at)
         VALUES ($1, $2, $3, $4)`,
        [input.requestId, input.organizationId, monthStart, now],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async release(requestId: string): Promise<void> {
    if (this.pool === undefined) {
      throw new Error('Sandbox dispatch budget database is unavailable');
    }
    await this.pool.query(
      `UPDATE sandbox_dispatch_reservations
       SET status = 'released', released_at = now()
       WHERE request_id = $1 AND status = 'reserved'`,
      [requestId],
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

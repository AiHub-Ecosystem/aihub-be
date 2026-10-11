import { getMetrics } from '@/common/observability/metrics';
import { createPostgresPool } from './postgres-pool';

describe('Postgres pool metrics', () => {
  it('scrapes live counts under the factory pool name', async () => {
    const pool = createPostgresPool('integration-test', { max: 2 });

    try {
      const payload = await getMetrics();

      expect(payload).toContain(
        'aihub_postgres_pool_total{pool="integration-test"} 0',
      );
      expect(payload).toContain(
        'aihub_postgres_pool_idle{pool="integration-test"} 0',
      );
      expect(payload).toContain(
        'aihub_postgres_pool_waiting{pool="integration-test"} 0',
      );
    } finally {
      await pool.end();
    }
  });
});

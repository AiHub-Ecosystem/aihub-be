import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { OPERATION_IDS } from '@/catalog/operation-id';
import { buildOpenApiDocument } from '@/openapi/build-openapi-document';
import {
  METRICS_ROUTE_PATH,
  setDownstreamPoolQueuedSource,
  setPostgresPoolStatsSource,
} from './metrics';
import { registerMetricsRoute } from './metrics.route';

describe('metrics scrape endpoint', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    const fastify = app.getHttpAdapter().getInstance();
    registerMetricsRoute(fastify);

    await app.init();
    await fastify.ready();
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address();
    baseUrl =
      typeof address === 'object' && address !== null
        ? `http://127.0.0.1:${address.port}`
        : '';
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a scrape without authentication', async () => {
    const response = await fetch(`${baseUrl}${METRICS_ROUTE_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    await expect(response.text()).resolves.toContain('# HELP');
  });

  it('emits request and runtime metric families on the scrape', async () => {
    setPostgresPoolStatsSource(() => [
      { pool: 'runtime', roles: ['runtime'], total: 4, idle: 2, waiting: 1 },
    ]);
    setDownstreamPoolQueuedSource(() => [
      { origin: 'https://ai-writing.test', queued: 3 },
    ]);

    try {
      const payload = await (
        await fetch(`${baseUrl}${METRICS_ROUTE_PATH}`)
      ).text();

      // Present as declared families; a counter with no observation yet emits
      // only its HELP/TYPE header, which is what proves it is registered.
      for (const name of [
        'aihub_requests_total',
        'aihub_request_duration_seconds',
        'aihub_downstream_duration_seconds',
        'aihub_tokens_total',
        'aihub_metering_incomplete_total',
        'aihub_redis_unavailable_total',
        'aihub_otel_export_failures_total',
        'aihub_otel_dropped_spans_total',
        'aihub_process_cpu_seconds_total',
        'aihub_process_resident_memory_bytes',
        'aihub_process_heap_used_bytes',
        'aihub_event_loop_lag_seconds',
        'aihub_postgres_pool_total',
        'aihub_postgres_pool_idle',
        'aihub_postgres_pool_waiting',
        'aihub_downstream_pool_queued',
      ]) {
        expect(payload).toContain(`# HELP ${name} `);
      }
      expect(payload).toContain(
        'aihub_postgres_pool_waiting{pool="runtime"} 1',
      );
      expect(payload).toContain(
        'aihub_downstream_pool_queued{origin="https://ai-writing.test"} 3',
      );
    } finally {
      setDownstreamPoolQueuedSource(undefined);
      setPostgresPoolStatsSource(undefined);
    }
  });

  it('never enters the operation catalog', () => {
    expect(Object.keys(OPERATION_CATALOG)).toEqual(OPERATION_IDS);
    expect(
      Object.values(OPERATION_CATALOG).some((operation) =>
        operation.path.startsWith(METRICS_ROUTE_PATH),
      ),
    ).toBe(false);
  });

  it('never enters the generated OpenAPI document', () => {
    const document = buildOpenApiDocument() as {
      readonly paths?: Record<string, unknown>;
    };

    expect(Object.keys(document.paths ?? {})).not.toContain(METRICS_ROUTE_PATH);
    expect(JSON.stringify(document)).not.toContain(METRICS_ROUTE_PATH);
  });
});

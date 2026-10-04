import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { OPERATION_IDS } from '@/catalog/operation-id';
import { buildOpenApiDocument } from '@/openapi/build-openapi-document';
import { METRICS_ROUTE_PATH } from './metrics';
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

  it('emits the five series issue #198 owns, under the spec L.2 names', async () => {
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
    ]) {
      expect(payload).toContain(`# HELP ${name} `);
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
    const document = buildOpenApiDocument('0.0.0-test') as {
      readonly paths?: Record<string, unknown>;
    };

    expect(Object.keys(document.paths ?? {})).not.toContain(METRICS_ROUTE_PATH);
    expect(JSON.stringify(document)).not.toContain(METRICS_ROUTE_PATH);
  });
});

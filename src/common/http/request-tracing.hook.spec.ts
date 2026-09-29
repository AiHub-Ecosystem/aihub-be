import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerRequestTracing } from './request-tracing.hook';

describe('registerRequestTracing', () => {
  let app: FastifyInstance | undefined;
  let sdk: NodeSDK;
  let exporter: InMemorySpanExporter;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    sdk = new NodeSDK({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      instrumentations: [],
    });
    sdk.start();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    exporter.reset();
  });

  afterAll(async () => {
    await sdk.shutdown();
  });

  it('keeps child I/O spans under a safe route-template request span', async () => {
    app = Fastify({ genReqId: () => 'req_test' });
    const tracer = trace.getTracer('aihub.request.test');
    registerRequestTracing(app, tracer);
    app.get('/v1/items/:itemId', async () => {
      const child = tracer.startSpan('pg.query:SELECT');
      child.end();
      return { ok: true };
    });

    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/items/private-value?token=private-value',
    });

    expect(response.statusCode).toBe(200);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining(['GET /v1/items/:itemId', 'pg.query:SELECT']),
    );
    const requestSpan = spans.find(
      (span) => span.attributes['aihub.request_id'] === 'req_test',
    );
    const childSpan = spans.find((span) => span.name === 'pg.query:SELECT');

    expect(requestSpan?.name).toBe('GET /v1/items/:itemId');
    expect(requestSpan?.attributes).toMatchObject({
      'http.route': '/v1/items/:itemId',
      'aihub.request_id': 'req_test',
      'http.response.status_code': 200,
    });
    expect(JSON.stringify(requestSpan?.attributes)).not.toContain(
      'private-value',
    );
    expect(childSpan?.parentSpanContext?.spanId).toBe(
      requestSpan?.spanContext().spanId,
    );
  });

  it('skips health checks', async () => {
    app = Fastify();
    registerRequestTracing(app, trace.getTracer('aihub.request.test'));
    app.get('/health', async () => ({ ok: true }));

    await app.ready();
    await app.inject({ method: 'GET', url: '/health' });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

import { trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';

import {
  downstreamUrlAttributes,
  postgresOperationName,
  redisOperationName,
} from './span-sanitizers';

const exporterEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();

export const tracingEnabled =
  exporterEndpoint !== undefined && exporterEndpoint.length > 0;

if (exporterEndpoint !== undefined && exporterEndpoint.length > 0) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME?.trim() || 'aihub-be',
    sampler: new AlwaysOnSampler(),
    textMapPropagator: new W3CTraceContextPropagator(),
    traceExporter: new OTLPTraceExporter({ url: exporterEndpoint }),
    instrumentations: [
      new IORedisInstrumentation({
        dbStatementSerializer: redisOperationName,
        requireParentSpan: true,
      }),
      new PgInstrumentation({
        enhancedDatabaseReporting: false,
        requireParentSpan: true,
        addSqlCommenterCommentToQueries: false,
        requestHook: (span, request) => {
          const operation = postgresOperationName(request.query.text);
          span.setAttribute('db.query.text', operation);
          span.setAttribute('db.statement', operation);
        },
      }),
      new UndiciInstrumentation({
        requireParentforSpans: true,
        startSpanHook: (request) =>
          downstreamUrlAttributes(request.origin, request.path),
      }),
    ],
  });

  sdk.start();
  process.once('beforeExit', () => {
    void sdk.shutdown().catch(() => undefined);
  });
}

export const requestTracer = tracingEnabled
  ? trace.getTracer('aihub.request')
  : undefined;

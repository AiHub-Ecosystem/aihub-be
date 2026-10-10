import { trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';

import { getRuntimeConfiguration } from '@/config/runtime-configuration';
import {
  downstreamUrlAttributes,
  postgresOperationName,
  redisOperationName,
} from './span-sanitizers';

const configuration = getRuntimeConfiguration();
const exporterEndpoint = configuration.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const SHUTDOWN_TIMEOUT_MS = 5_000;
let sdk: NodeSDK | undefined;
let shutdownPromise: Promise<void> | undefined;

export const tracingEnabled =
  exporterEndpoint !== undefined && exporterEndpoint.length > 0;

if (exporterEndpoint !== undefined && exporterEndpoint.length > 0) {
  sdk = new NodeSDK({
    serviceName: configuration.OTEL_SERVICE_NAME,
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
}

export function shutdownOpenTelemetry(): Promise<void> {
  if (sdk === undefined) {
    return Promise.resolve();
  }
  if (shutdownPromise !== undefined) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sdk?.shutdown() ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Export failure must not hold the process past the deployment grace period.
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  })();

  return shutdownPromise;
}

export const requestTracer = tracingEnabled
  ? trace.getTracer('aihub.request')
  : undefined;

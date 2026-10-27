import {
  requestTracer,
  shutdownOpenTelemetry,
  tracingEnabled,
} from '@/common/observability/open-telemetry';

async function main(): Promise<void> {
  if (!tracingEnabled || requestTracer === undefined) {
    throw new Error('tracing is not enabled');
  }
  requestTracer.startSpan('otel-bootstrap-probe').end();
  await shutdownOpenTelemetry();
}

void main();

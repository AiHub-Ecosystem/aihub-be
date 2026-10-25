import { Counter } from '@prometheus-io/client';

import { registry } from './metrics';

const traceExportFailures = new Counter({
  name: 'aihub_otel_export_failures_total',
  help: 'OTLP trace export batches that failed in this process.',
  registers: [registry],
});
const droppedTraceSpans = new Counter({
  name: 'aihub_otel_dropped_spans_total',
  help: 'Trace spans dropped by failed OTLP exports or a full SDK export queue.',
  registers: [registry],
});

export function recordTraceExportFailure(spanCount: number): void {
  try {
    traceExportFailures.inc();
    if (spanCount > 0) droppedTraceSpans.inc(spanCount);
  } catch {
    // Telemetry must not change the request or export outcome.
  }
}

export function recordTraceQueueDrops(spanCount: number): void {
  if (!Number.isFinite(spanCount) || spanCount <= 0) return;

  try {
    droppedTraceSpans.inc(spanCount);
  } catch {
    // Telemetry must not change the request or export outcome.
  }
}

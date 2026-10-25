import { ExportResultCode } from '@opentelemetry/core';
import {
  DataPointType,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import { recordTraceQueueDrops } from './trace-export-metrics';

const PROCESSED_SPANS_METRIC = 'otel.sdk.processor.span.processed';
const BATCH_PROCESSOR = 'batching_span_processor';
const QUEUE_FULL = 'queue_full';

/** Bridges the SDK's queue-full self-observation into the existing Prometheus registry. */
export class TraceProcessorMetricsExporter implements PushMetricExporter {
  private lastDroppedSpanCount = 0;

  export(
    metrics: ResourceMetrics,
    callback: Parameters<PushMetricExporter['export']>[1],
  ): void {
    let droppedSpanCount = 0;
    let foundQueueDropCounter = false;

    for (const scope of metrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (
          metric.descriptor.name !== PROCESSED_SPANS_METRIC ||
          metric.dataPointType !== DataPointType.SUM
        ) {
          continue;
        }

        for (const point of metric.dataPoints) {
          if (
            point.attributes['otel.component.type'] === BATCH_PROCESSOR &&
            point.attributes['error.type'] === QUEUE_FULL
          ) {
            foundQueueDropCounter = true;
            droppedSpanCount += point.value;
          }
        }
      }
    }

    if (foundQueueDropCounter) {
      const delta =
        droppedSpanCount >= this.lastDroppedSpanCount
          ? droppedSpanCount - this.lastDroppedSpanCount
          : droppedSpanCount;
      recordTraceQueueDrops(delta);
      this.lastDroppedSpanCount = droppedSpanCount;
    }

    callback({ code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

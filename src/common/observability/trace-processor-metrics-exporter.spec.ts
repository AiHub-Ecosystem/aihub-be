import { ExportResultCode } from '@opentelemetry/core';
import {
  AggregationTemporality,
  DataPointType,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import { getMetrics } from './metrics';
import { TraceProcessorMetricsExporter } from './trace-processor-metrics-exporter';

describe('trace processor metrics exporter', () => {
  it('bridges queue-full spans as a bounded dropped-span counter', async () => {
    const exporter = new TraceProcessorMetricsExporter();
    const before = await getMetrics();
    const droppedBefore = metricValue(before, 'aihub_otel_dropped_spans_total');

    exportMetric(exporter, 0);
    exportMetric(exporter, 3);
    exportMetric(exporter, 8);
    exportMetric(exporter, 8);
    exportMetric(exporter, 2);

    const after = await getMetrics();
    expect(metricValue(after, 'aihub_otel_dropped_spans_total')).toBe(
      droppedBefore + 10,
    );
  });

  it('ignores successfully processed spans and other processors', async () => {
    const exporter = new TraceProcessorMetricsExporter();
    const before = await getMetrics();
    const droppedBefore = metricValue(before, 'aihub_otel_dropped_spans_total');

    exportMetric(exporter, 20, 'successful', 'batching_span_processor');
    exportMetric(exporter, 20, 'queue_full', 'simple_span_processor');

    const after = await getMetrics();
    expect(metricValue(after, 'aihub_otel_dropped_spans_total')).toBe(
      droppedBefore,
    );
  });
});

function exportMetric(
  exporter: TraceProcessorMetricsExporter,
  value: number,
  errorType = 'queue_full',
  processorType = 'batching_span_processor',
): void {
  let resultCode: ExportResultCode | undefined;
  exporter.export(
    {
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: {
                name: 'otel.sdk.processor.span.processed',
                description: 'processed spans',
                unit: '{span}',
                valueType: 1,
              },
              dataPointType: DataPointType.SUM,
              aggregationTemporality: AggregationTemporality.CUMULATIVE,
              isMonotonic: true,
              dataPoints: [
                {
                  attributes: {
                    'error.type': errorType,
                    'otel.component.type': processorType,
                  },
                  value,
                  startTime: [0, 0],
                  endTime: [0, 0],
                },
              ],
            },
          ],
          scope: { name: '@opentelemetry/sdk-trace' },
        },
      ],
      resource: {} as ResourceMetrics['resource'],
    },
    (result) => {
      resultCode = result.code;
    },
  );

  expect(resultCode).toBe(ExportResultCode.SUCCESS);
}

function metricValue(payload: string, name: string): number {
  const match = payload.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return Number(match?.[1] ?? 0);
}

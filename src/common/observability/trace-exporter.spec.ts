import { Logger } from '@nestjs/common';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { getMetrics } from './metrics';
import { withTraceExportSignals } from './trace-exporter';

describe('trace exporter outage signals', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts failed batches and emits only one safe log until recovery', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const spans = [{}, {}] as ReadableSpan[];
    let resultCallback: Parameters<SpanExporter['export']>[1] | undefined;
    const exporter: SpanExporter = {
      export: (_spans, callback) => {
        resultCallback = callback;
      },
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    const wrapped = withTraceExportSignals(exporter);
    const before = await getMetrics();
    const failuresBefore = metricValue(
      before,
      'aihub_otel_export_failures_total',
    );
    const droppedBefore = metricValue(before, 'aihub_otel_dropped_spans_total');

    const fail = (): void => {
      wrapped.export(spans, () => undefined);
      resultCallback?.({
        code: ExportResultCode.FAILED,
        error: new Error('sensitive receiver response'),
      });
    };

    fail();
    fail();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(
      'sensitive receiver response',
    );
    const after = await getMetrics();
    expect(metricValue(after, 'aihub_otel_export_failures_total')).toBe(
      failuresBefore + 2,
    );
    expect(metricValue(after, 'aihub_otel_dropped_spans_total')).toBe(
      droppedBefore + 4,
    );
  });

  it('logs a new outage after a successful export', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const results = [
      ExportResultCode.FAILED,
      ExportResultCode.SUCCESS,
      ExportResultCode.FAILED,
    ];
    const exporter: SpanExporter = {
      export: (_spans, callback) => {
        callback({ code: results.shift() ?? ExportResultCode.SUCCESS });
      },
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    const wrapped = withTraceExportSignals(exporter);

    wrapped.export([], () => undefined);
    wrapped.export([], () => undefined);
    wrapped.export([], () => undefined);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('converts synchronous exporter throws into failed batch results', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const exporter: SpanExporter = {
      export: () => {
        throw new Error('receiver unavailable');
      },
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    const wrapped = withTraceExportSignals(exporter);
    let result: Parameters<SpanExporter['export']>[1] extends (
      result: infer T,
    ) => void
      ? T
      : never;

    wrapped.export([{} as ReadableSpan], (value) => {
      result = value;
    });

    expect(result!.code).toBe(ExportResultCode.FAILED);
  });
});

function metricValue(payload: string, name: string): number {
  const match = payload.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm'));
  return Number(match?.[1] ?? 0);
}

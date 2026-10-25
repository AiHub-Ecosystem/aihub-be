import { Logger } from '@nestjs/common';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { recordTraceExportFailure } from './trace-export-metrics';

const logger = new Logger('OpenTelemetry');

export function withTraceExportSignals(exporter: SpanExporter): SpanExporter {
  let outageLogged = false;

  return {
    export(spans: ReadableSpan[], callback) {
      let callbackCalled = false;
      const finish = (result: Parameters<typeof callback>[0]): void => {
        if (callbackCalled) return;
        callbackCalled = true;

        if (result.code === ExportResultCode.SUCCESS) {
          outageLogged = false;
        } else {
          recordTraceExportFailure(spans.length);
          if (!outageLogged) {
            logger.warn(
              'OTLP trace export failed; the current batch was dropped',
            );
            outageLogged = true;
          }
        }

        callback(result);
      };

      try {
        exporter.export(spans, finish);
      } catch (cause) {
        if (callbackCalled) throw cause;
        finish({
          code: ExportResultCode.FAILED,
          error:
            cause instanceof Error
              ? cause
              : new Error('OTLP trace export failed'),
        });
      }
    },
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
    shutdown: () => exporter.shutdown(),
  };
}

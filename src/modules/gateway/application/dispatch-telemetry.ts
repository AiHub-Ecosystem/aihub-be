import type { MeteringTelemetry } from '@/modules/metering/application/metering-finalizer.port';
import {
  normalizeMeteringModels,
  normalizeMeteringTelemetry,
  normalizeMeteringUsage,
} from '@/modules/metering/public/telemetry';
import type { DispatchResult } from './operation-dispatcher.port';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readDispatchTelemetry(
  value: Record<string, unknown>,
): MeteringTelemetry {
  const usageValue = value.usage;
  const usage = isRecord(usageValue)
    ? normalizeMeteringUsage({
        input_tokens: usageValue.inputTokens,
        output_tokens: usageValue.outputTokens,
        total_tokens: usageValue.totalTokens,
      })
    : undefined;
  const models = normalizeMeteringModels(value.models);
  const aiProcessingMs =
    typeof value.aiProcessingMs === 'number' ? value.aiProcessingMs : undefined;

  return normalizeMeteringTelemetry({
    ...(usage === undefined ? {} : { usage }),
    ...(models === undefined ? {} : { models }),
    ...(aiProcessingMs === undefined ? {} : { aiProcessingMs }),
  });
}

export function withDispatchTelemetry<TData>(
  result: Pick<DispatchResult<TData>, 'operation' | 'data' | 'downstreamMs'>,
  telemetry: MeteringTelemetry,
): DispatchResult<TData> {
  return {
    ...result,
    ...(telemetry.usage === undefined ? {} : { usage: telemetry.usage }),
    ...(telemetry.models === undefined ? {} : { models: telemetry.models }),
    ...(telemetry.aiProcessingMs === undefined
      ? {}
      : { aiProcessingMs: telemetry.aiProcessingMs }),
  };
}

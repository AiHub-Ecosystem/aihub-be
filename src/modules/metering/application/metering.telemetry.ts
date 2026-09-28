import type {
  MeteringModel,
  MeteringTelemetry,
  MeteringUsage,
} from './metering-finalizer.port';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

export function normalizeMeteringUsage(
  value: unknown,
): MeteringUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = nonNegativeInteger(value.input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  const totalTokens = nonNegativeInteger(value.total_tokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export function normalizeMeteringModels(
  value: unknown,
): readonly MeteringModel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const models = value.flatMap((item): MeteringModel[] => {
    if (!isRecord(item)) {
      return [];
    }

    const provider = boundedText(item.provider);
    const name = boundedText(item.name);
    return provider === undefined || name === undefined
      ? []
      : [{ provider, name }];
  });

  return models.length === 0 ? undefined : models;
}

function normalizeAiProcessingMs(value: unknown): number | undefined {
  return nonNegativeInteger(value);
}

export function extractDownstreamTelemetry(
  body: unknown,
): MeteringTelemetry | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const usage = normalizeMeteringUsage(body.usage);
  const models = normalizeMeteringModels(body.models);
  const metrics = isRecord(body.metrics) ? body.metrics : undefined;
  const aiProcessingMs = normalizeAiProcessingMs(metrics?.ai_processing_ms);

  if (
    usage === undefined &&
    models === undefined &&
    aiProcessingMs === undefined
  ) {
    return undefined;
  }

  return {
    ...(usage === undefined ? {} : { usage }),
    ...(models === undefined ? {} : { models }),
    ...(aiProcessingMs === undefined ? {} : { aiProcessingMs }),
  };
}

export function normalizeMeteringTelemetry(
  input: MeteringTelemetry,
): MeteringTelemetry {
  const usage = normalizeMeteringUsage({
    input_tokens: input.usage?.inputTokens,
    output_tokens: input.usage?.outputTokens,
    total_tokens: input.usage?.totalTokens,
  });
  const models = normalizeMeteringModels(input.models);
  const aiProcessingMs = normalizeAiProcessingMs(input.aiProcessingMs);

  return {
    ...(usage === undefined ? {} : { usage }),
    ...(models === undefined ? {} : { models }),
    ...(aiProcessingMs === undefined ? {} : { aiProcessingMs }),
  };
}

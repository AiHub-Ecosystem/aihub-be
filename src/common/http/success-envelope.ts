export interface SuccessEnvelope<TData> {
  readonly data: TData;
  readonly meta: {
    readonly request_id: string;
    readonly correlation_id?: string;
    readonly service: string;
    readonly operation: string;
    readonly timing: {
      readonly downstream_ms: number;
      readonly gateway_overhead_ms: number;
      readonly total_ms: number;
    };
  };
}

export function buildSuccessEnvelope<TData>(input: {
  readonly data: TData;
  readonly operation: string;
  readonly downstreamMs: number;
  readonly totalMs: number;
  readonly requestId: string;
  readonly correlationId?: string;
}): SuccessEnvelope<TData> {
  return {
    data: input.data,
    meta: {
      request_id: input.requestId,
      ...(input.correlationId === undefined
        ? {}
        : { correlation_id: input.correlationId }),
      service: input.operation.split('.')[0] ?? 'unknown',
      operation: input.operation,
      timing: {
        downstream_ms: input.downstreamMs,
        gateway_overhead_ms: Math.max(0, input.totalMs - input.downstreamMs),
        total_ms: input.totalMs,
      },
    },
  };
}

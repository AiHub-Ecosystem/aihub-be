import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type Observable, map } from 'rxjs';

import { isRequestId } from '../request-context/request-id';

interface DispatchResultLike {
  readonly operation: string;
  readonly data: unknown;
  readonly downstreamMs: number;
}

interface SuccessEnvelope<TData> {
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

function isDispatchResult(value: unknown): value is DispatchResultLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<DispatchResultLike>;
  return (
    typeof candidate.operation === 'string' &&
    typeof candidate.downstreamMs === 'number' &&
    'data' in candidate
  );
}

function correlationId(request: FastifyRequest): string | undefined {
  const header = request.headers['x-correlation-id'];
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

@Injectable()
export class SuccessEnvelopeInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessEnvelope<unknown>> {
    const startedAt = performance.now();
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    return next.handle().pipe(
      map((value: unknown) => {
        if (!isDispatchResult(value)) {
          throw new Error('success response is missing dispatch metadata');
        }

        const totalMs = Math.round(performance.now() - startedAt);
        const downstreamMs = Math.max(0, Math.round(value.downstreamMs));
        const requestId = isRequestId(request.id)
          ? request.id
          : String(request.id);
        const correlation = correlationId(request);
        const meta = {
          request_id: requestId,
          ...(correlation === undefined ? {} : { correlation_id: correlation }),
          service: value.operation.split('.')[0] ?? 'unknown',
          operation: value.operation,
          timing: {
            downstream_ms: downstreamMs,
            gateway_overhead_ms: Math.max(0, totalMs - downstreamMs),
            total_ms: totalMs,
          },
        };

        return { data: value.data, meta };
      }),
    );
  }
}

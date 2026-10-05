import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Observable, mergeMap } from 'rxjs';

import { isOperationId } from '@/catalog/operation-id';
import {
  type SuccessEnvelope,
  buildSuccessEnvelope,
} from '@/common/http/success-envelope';
import { isRequestId } from '@/common/request-context/request-id';
import { completeRequestMetering } from '@/modules/metering/application/metering-completion';
import {
  addMeteringEvidence,
  getMeteringEvidence,
} from '@/modules/metering/application/metering-evidence';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from '@/modules/metering/application/metering-finalizer.port';
import type {
  MeteringModel,
  MeteringUsage,
} from '@/modules/metering/application/metering-finalizer.port';

interface DispatchResultLike {
  readonly operation: string;
  readonly data: unknown;
  readonly downstreamMs: number;
  readonly usage?: MeteringUsage;
  readonly models?: readonly MeteringModel[];
  readonly aiProcessingMs?: number;
  readonly idempotentReplay?: boolean;
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
  constructor(
    @Inject(METERING_FINALIZER)
    private readonly metering: MeteringFinalizerPort,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessEnvelope<unknown>> {
    const startedAt = performance.now();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        if (!isDispatchResult(value)) {
          throw new Error('success response is missing dispatch metadata');
        }

        const downstreamMs = Math.max(0, Math.round(value.downstreamMs));
        if (
          getMeteringEvidence(request) !== undefined &&
          isOperationId(value.operation)
        ) {
          addMeteringEvidence(request, {
            downstreamMs,
            ...(value.usage === undefined ? {} : { usage: value.usage }),
            ...(value.models === undefined ? {} : { models: value.models }),
            ...(value.aiProcessingMs === undefined
              ? {}
              : { aiProcessingMs: value.aiProcessingMs }),
            ...(value.idempotentReplay === undefined
              ? {}
              : { idempotentReplay: value.idempotentReplay }),
            modelCalled: true,
          });
        }

        const totalMs = Math.max(0, Math.round(performance.now() - startedAt));
        const requestId = isRequestId(request.id)
          ? request.id
          : String(request.id);
        const correlation = correlationId(request);
        if (value.idempotentReplay === true) {
          reply.header('Idempotent-Replay', 'true');
        }

        // A request whose id never validated cannot be identified, so there is
        // nothing to write a record against; the envelope below still carries
        // the raw id exactly as it did before.
        if (isRequestId(request.id)) {
          await completeRequestMetering(
            getMeteringEvidence(request),
            this.metering,
            {
              requestId: request.id,
              outcome: 'success',
              httpStatus: 200,
              totalMs,
            },
          );
        }

        return buildSuccessEnvelope({
          data: value.data,
          operation: value.operation,
          downstreamMs,
          totalMs,
          requestId,
          ...(correlation === undefined ? {} : { correlationId: correlation }),
        });
      }),
    );
  }
}

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Observable, finalize } from 'rxjs';

import { getConcurrencyPermit } from './concurrency-permit';

function finishResponse(permit: ReturnType<typeof getConcurrencyPermit>): void {
  if (permit === undefined) {
    return;
  }
  void permit.responseFinished().catch(() => undefined);
}

function finishRequest(permit: ReturnType<typeof getConcurrencyPermit>): void {
  if (permit === undefined) {
    return;
  }
  void permit.requestFinished().catch(() => undefined);
}

@Injectable()
export class ConcurrencyReleaseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const permit = getConcurrencyPermit(request);

    if (permit === undefined) {
      return next.handle();
    }

    const onResponseFinished = (): void => finishResponse(permit);
    reply.raw.once('finish', onResponseFinished);
    reply.raw.once('close', onResponseFinished);

    return next.handle().pipe(
      finalize(() => {
        reply.raw.off('finish', onResponseFinished);
        reply.raw.off('close', onResponseFinished);
        finishRequest(permit);
      }),
    );
  }
}

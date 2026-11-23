import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { type Observable, defer } from 'rxjs';

@Injectable()
export class RequestLogContextInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return defer(() =>
      this.logger.runInContext(() => next.handle(), {
        bindings: { request_id: request.id },
        inherit: true,
      }),
    );
  }
}

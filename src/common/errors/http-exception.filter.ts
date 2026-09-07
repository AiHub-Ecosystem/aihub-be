import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from './app-error';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const response = http.getResponse<FastifyReply>();
    const requestId = typeof request.id === 'string' ? request.id : 'unknown';
    const status = exception instanceof AppError ? exception.httpStatus : 500;

    response.status(status).send(AppError.toEnvelope(exception, requestId));
  }
}

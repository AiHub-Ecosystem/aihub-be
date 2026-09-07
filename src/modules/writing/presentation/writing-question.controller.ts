import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import type { FastifyRequest } from 'fastify';

import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import { AppError } from '../../../common/errors/app-error';
import { SuccessEnvelopeInterceptor } from '../../../common/http/success-envelope.interceptor';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import {
  type Task1QuestionRequest,
  Task1QuestionRequestSchema,
  type Task1QuestionResponse,
} from '../../../contracts/writing/task1';
import {
  type DispatchResult,
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from '../../gateway/application/operation-dispatcher.port';
import { DevelopmentOnlyGuard } from './development-only.guard';

const OPERATION = 'writing.task1.question.generate' as const;
const MAX_BODY_BYTES = OPERATION_CATALOG[OPERATION].maxBodyBytes;

function invalidRequest(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    httpStatus: 400,
    retryable: false,
  });
}

function parseBody(body: unknown): Task1QuestionRequest {
  const serialized = JSON.stringify(body ?? null);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new AppError({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large',
      httpStatus: 413,
      retryable: false,
    });
  }

  if (!Value.Check(Task1QuestionRequestSchema, body)) {
    throw invalidRequest();
  }

  try {
    return Value.Parse(Task1QuestionRequestSchema, body);
  } catch (error) {
    throw new AppError({
      code: 'INVALID_REQUEST',
      message: 'Request failed validation',
      httpStatus: 400,
      retryable: false,
      cause: error,
    });
  }
}

@Controller()
@UseGuards(DevelopmentOnlyGuard)
@UseInterceptors(SuccessEnvelopeInterceptor)
export class WritingQuestionController {
  constructor(
    @Inject(OPERATION_DISPATCHER)
    private readonly dispatcher: OperationDispatcherPort,
  ) {}

  @Post(OPERATION_CATALOG[OPERATION].path)
  @HttpCode(200)
  async generateTask1Question(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<Task1QuestionResponse>> {
    const input = parseBody(body);
    const context = createRequestContext({
      requestId: String(request.id),
      receivedAt: new Date(),
      deadlineMs: OPERATION_CATALOG[OPERATION].timeoutMs,
      organizationId: 'local-development',
      apiKeyId: 'local-development',
      scopes: [OPERATION_CATALOG[OPERATION].requiredScope],
    });

    return this.dispatcher.dispatch(OPERATION, input, context);
  }
}

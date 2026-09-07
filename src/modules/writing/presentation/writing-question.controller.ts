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
import { RateLimitGuard } from '../../gateway/presentation/rate-limit.guard';
import { ApiKeyGuard } from '../../identity/presentation/api-key.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '../../identity/presentation/authenticated-request';
import { RequireOperation } from '../../identity/presentation/require-operation.decorator';

const OPERATION = 'writing.task1.question.generate' as const;

function invalidRequest(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    httpStatus: 400,
    retryable: false,
  });
}

// Body size is enforced earlier, before parsing, by the `onRequest` hook
// registered in main.ts (see `registerBodySizeGuard`) — a body that reaches
// here has already passed that check.
function parseBody(body: unknown): Task1QuestionRequest {
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
@UseGuards(ApiKeyGuard, RateLimitGuard)
@UseInterceptors(SuccessEnvelopeInterceptor)
export class WritingQuestionController {
  constructor(
    @Inject(OPERATION_DISPATCHER)
    private readonly dispatcher: OperationDispatcherPort,
  ) {}

  @Post(OPERATION_CATALOG[OPERATION].path)
  @HttpCode(200)
  @RequireOperation(OPERATION)
  async generateTask1Question(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<Task1QuestionResponse>> {
    const input = parseBody(body);
    const authenticated = getAuthenticatedApiKey(request);
    const context = createRequestContext({
      requestId: String(request.id),
      receivedAt: new Date(),
      deadlineMs: OPERATION_CATALOG[OPERATION].timeoutMs,
      organizationId: authenticated.organizationId,
      apiKeyId: authenticated.apiKeyId,
      scopes: authenticated.scopes,
    });

    return this.dispatcher.dispatch(OPERATION, input, context);
  }
}

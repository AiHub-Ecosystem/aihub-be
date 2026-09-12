import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import { AppError } from '../../../common/errors/app-error';
import { createClientDisconnectSignal } from '../../../common/http/client-disconnect-signal';
import { SuccessEnvelopeInterceptor } from '../../../common/http/success-envelope.interceptor';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type { SpeakingGradeResponse } from '../../../contracts/speaking/grading';
import {
  type DispatchResult,
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from '../../gateway/application/operation-dispatcher.port';
import { ConcurrencyReleaseInterceptor } from '../../gateway/presentation/concurrency-release.interceptor';
import { ConcurrencyGuard } from '../../gateway/presentation/concurrency.guard';
import { RateLimitGuard } from '../../gateway/presentation/rate-limit.guard';
import { ApiKeyGuard } from '../../identity/presentation/api-key.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '../../identity/presentation/authenticated-request';
import { RequireOperation } from '../../identity/presentation/require-operation.decorator';
import { UserAssertionGuard } from '../../identity/presentation/user-assertion.guard';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '../application/speaking-multipart-parser.port';
import { createFastifySpeakingMultipartSource } from './fastify-speaking-multipart.source';

const OPERATION = 'speaking.grading' as const;

function userId(request: AuthenticatedRequest): string {
  const value = request.aihubIdentity?.userId;
  if (value === undefined || value.trim().length === 0) {
    throw new AppError({
      code: 'USER_ASSERTION_REQUIRED',
      message: 'A valid user assertion is required',
      retryable: false,
    });
  }
  return value;
}

@Controller()
@UseGuards(ApiKeyGuard, UserAssertionGuard, RateLimitGuard, ConcurrencyGuard)
@UseInterceptors(ConcurrencyReleaseInterceptor, SuccessEnvelopeInterceptor)
export class SpeakingGradingController {
  constructor(
    @Inject(OPERATION_DISPATCHER)
    private readonly dispatcher: OperationDispatcherPort,
    @Inject(SPEAKING_MULTIPART_PARSER)
    private readonly multipartParser: SpeakingMultipartParserPort,
  ) {}

  @Post(OPERATION_CATALOG[OPERATION].path)
  @HttpCode(200)
  @RequireOperation(OPERATION)
  async grade(
    @Req() request: AuthenticatedRequest,
  ): Promise<DispatchResult<SpeakingGradeResponse>> {
    const authenticated = getAuthenticatedApiKey(request);
    const verifiedUserId = userId(request);
    const { signal, dispose } = createClientDisconnectSignal(request.raw);

    try {
      const context = createRequestContext({
        requestId: String(request.id),
        receivedAt: new Date(),
        deadlineMs: OPERATION_CATALOG[OPERATION].timeoutMs,
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        userId: verifiedUserId,
        scopes: authenticated.scopes,
        signal,
      });
      const uploadSignal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(OPERATION_CATALOG[OPERATION].timeoutMs),
      ]);
      const source = createFastifySpeakingMultipartSource(request);
      const input = await this.multipartParser.parse(source, uploadSignal);

      return await this.dispatcher.dispatch(OPERATION, input, context);
    } finally {
      dispose();
    }
  }
}

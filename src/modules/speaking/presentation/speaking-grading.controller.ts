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
import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  type RequestLifecycleState,
  createRequestLifecycleState,
  getRequestLifecycle,
} from '../../../common/http/request-lifecycle.hook';
import { SuccessEnvelopeInterceptor } from '../../../common/http/success-envelope.interceptor';
import { createRequestContext } from '../../../common/request-context/request-context.factory';

import {
  type SpeakingGradeJsonInput,
  SpeakingGradeJsonRequestSchema,
  type SpeakingGradeResponse,
} from '../../../contracts/speaking/grading';
import {
  type DispatchResult,
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from '../../gateway/application/operation-dispatcher.port';
import { ConcurrencyReleaseInterceptor } from '../../gateway/presentation/concurrency-release.interceptor';
import { ConcurrencyGuard } from '../../gateway/presentation/concurrency.guard';
import { QuotaGuard } from '../../gateway/presentation/quota.guard';
import { RateLimitGuard } from '../../gateway/presentation/rate-limit.guard';
import { ApiKeyGuard } from '../../identity/presentation/api-key.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '../../identity/presentation/authenticated-request';
import { RequireOperation } from '../../identity/presentation/require-operation.decorator';
import { UserIdentityGuard } from '../../identity/presentation/user-identity.guard';
import { isApprovedSpeakingAudioUrl } from '../application/speaking-audio-url.policy';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '../application/speaking-multipart-parser.port';
import { createFastifySpeakingMultipartSource } from './fastify-speaking-multipart.source';

const OPERATION = 'speaking.grading' as const;
const JSON_OPERATION = 'speaking.grading-json' as const;

function parseJsonBody(body: unknown): SpeakingGradeJsonInput {
  if (!Value.Check(SpeakingGradeJsonRequestSchema, body)) {
    throw invalidRequest();
  }

  try {
    const parsed = Value.Parse(SpeakingGradeJsonRequestSchema, body);
    if (!isApprovedSpeakingAudioUrl(parsed.audio_url)) {
      throw invalidRequest();
    }

    return {
      audioUrl: parsed.audio_url,
      part: parsed.part,
      questionId: parsed.question_id,
      ...(parsed.prompt_text === undefined
        ? {}
        : { promptText: parsed.prompt_text }),
      testType: parsed.test_type ?? 'Practice',
      ...(parsed.test_code === undefined ? {} : { testCode: parsed.test_code }),
      ...(parsed.transcript === undefined
        ? {}
        : { transcript: parsed.transcript }),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidRequest();
  }
}

function userId(request: AuthenticatedRequest): string {
  const value = request.aihubIdentity?.userId;
  if (value === undefined || value.trim().length === 0) {
    throw new AppError({
      code: 'USER_IDENTITY_REQUIRED',
      message: 'User identity is required in X-User-Identity',
      retryable: false,
    });
  }
  return value;
}

function requestLifecycle(
  request: AuthenticatedRequest,
  timeoutMs: number,
): RequestLifecycleState {
  return (
    getRequestLifecycle(request.raw) ??
    createRequestLifecycleState(request.raw, timeoutMs)
  );
}

@Controller()
@UseGuards(
  ApiKeyGuard,
  UserIdentityGuard,
  RateLimitGuard,
  QuotaGuard,
  ConcurrencyGuard,
)
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
    const lifecycle = requestLifecycle(
      request,
      OPERATION_CATALOG[OPERATION].timeoutMs,
    );

    try {
      const context = createRequestContext({
        requestId: String(request.id),
        receivedAt: lifecycle.receivedAt,
        deadlineMs: OPERATION_CATALOG[OPERATION].timeoutMs,
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        userId: verifiedUserId,
        scopes: authenticated.scopes,
        signal: lifecycle.signal,
      });
      const source = createFastifySpeakingMultipartSource(request);
      const input = await this.multipartParser.parse(source, context.signal);

      return await this.dispatcher.dispatch(OPERATION, input, context);
    } finally {
      lifecycle.dispose();
    }
  }

  @Post(OPERATION_CATALOG[JSON_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(JSON_OPERATION)
  async gradeJson(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<SpeakingGradeResponse>> {
    const input = parseJsonBody(body);
    const authenticated = getAuthenticatedApiKey(request);
    const verifiedUserId = userId(request);
    const lifecycle = requestLifecycle(
      request,
      OPERATION_CATALOG[JSON_OPERATION].timeoutMs,
    );

    try {
      const context = createRequestContext({
        requestId: String(request.id),
        receivedAt: lifecycle.receivedAt,
        deadlineMs: OPERATION_CATALOG[JSON_OPERATION].timeoutMs,
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        userId: verifiedUserId,
        scopes: authenticated.scopes,
        signal: lifecycle.signal,
      });

      return await this.dispatcher.dispatch(JSON_OPERATION, input, context);
    } finally {
      lifecycle.dispose();
    }
  }
}

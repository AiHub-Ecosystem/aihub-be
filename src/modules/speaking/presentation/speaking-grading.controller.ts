import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import {
  type RequestLifecycleState,
  getRequestLifecycle,
} from '@/common/http/request-lifecycle.hook';
import {
  type SpeakingGradeJsonInput,
  SpeakingGradeJsonRequestSchema,
  type SpeakingGradeResponse,
} from '@/contracts/speaking/grading';
import {
  GRADING_ORCHESTRATOR,
  type GradingOrchestratorPort,
  type GradingRequestMetadata,
} from '@/modules/gateway/application/grading-orchestrator.port';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { isApprovedSpeakingAudioUrl } from '@/modules/speaking/application/speaking-audio-url.policy';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '@/modules/speaking/application/speaking-multipart-parser.port';
import { Value } from '@sinclair/typebox/value';
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
    throw userIdentityRequired();
  }
  return value;
}

function requestLifecycle(
  request: AuthenticatedRequest,
): RequestLifecycleState {
  const lifecycle = getRequestLifecycle(request.raw);
  if (lifecycle === undefined) {
    throw new Error('Request lifecycle is missing');
  }
  return lifecycle;
}

function requestMetadata(
  request: AuthenticatedRequest,
  lifecycle: RequestLifecycleState,
): GradingRequestMetadata {
  const authenticated = getAuthenticatedApiKey(request);
  const verifiedUserId = userId(request);

  return {
    requestId: String(request.id),
    receivedAt: lifecycle.receivedAt,
    signal: lifecycle.signal,
    organizationId: authenticated.organizationId,
    apiKeyId: authenticated.apiKeyId,
    environment: authenticated.environment,
    ...(authenticated.sandboxOrganizationDispatchLimit === undefined
      ? {}
      : {
          sandboxOrganizationDispatchLimit:
            authenticated.sandboxOrganizationDispatchLimit,
        }),
    userId: verifiedUserId,
    scopes: authenticated.scopes,
  };
}

@Controller()
@GradedRequest()
export class SpeakingGradingController {
  constructor(
    @Inject(GRADING_ORCHESTRATOR)
    private readonly orchestrator: GradingOrchestratorPort,
    @Inject(SPEAKING_MULTIPART_PARSER)
    private readonly multipartParser: SpeakingMultipartParserPort,
  ) {}

  @Post(OPERATION_CATALOG[OPERATION].path)
  @HttpCode(200)
  @RequireOperation(OPERATION)
  async grade(
    @Req() request: AuthenticatedRequest,
  ): Promise<DispatchResult<SpeakingGradeResponse>> {
    const lifecycle = requestLifecycle(request);
    try {
      const metadata = requestMetadata(request, lifecycle);
      const source = createFastifySpeakingMultipartSource(request);
      const input = await this.multipartParser.parse(source, lifecycle.signal);

      return await this.orchestrator.execute({
        operation: OPERATION,
        input,
        ...metadata,
      });
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
    const lifecycle = requestLifecycle(request);
    try {
      const input = parseJsonBody(body);
      const metadata = requestMetadata(request, lifecycle);

      return await this.orchestrator.execute({
        operation: JSON_OPERATION,
        input,
        ...metadata,
      });
    } finally {
      lifecycle.dispose();
    }
  }
}

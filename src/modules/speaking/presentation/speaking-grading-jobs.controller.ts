import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { getRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  type SpeakingGradingJobPollResponse,
  type SpeakingGradingJobSubmitRequest,
  SpeakingGradingJobSubmitRequestSchema,
  type SpeakingGradingJobSubmitResponse,
} from '@/contracts/speaking/v2/grading-job';
import { RateLimitGuard } from '@/modules/gateway/presentation/rate-limit.guard';
import { ApiKeyUserIdentityGuard } from '@/modules/identity/api-keys/presentation/api-key-user-identity.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireApiKeyScope } from '@/modules/identity/shared/presentation/require-api-key-scope.decorator';
import { GetSpeakingGradingJob } from '@/modules/speaking/application/grading-jobs/get-speaking-grading-job';
import type { SpeakingGradingJobOwner } from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import { SubmitSpeakingGradingJob } from '@/modules/speaking/application/grading-jobs/submit-speaking-grading-job';
import type { SpeakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';

function speakingEnvironment(value: string): SpeakingAudioEnvironment {
  return value === 'sandbox' ? 'sandbox' : 'production';
}

function ownerFor(request: AuthenticatedRequest): SpeakingGradingJobOwner {
  const authenticated = getAuthenticatedApiKey(request);
  const identity = request.aihubIdentity;
  if (identity === undefined) {
    throw userIdentityRequired();
  }
  return {
    organizationId: authenticated.organizationId,
    endUserId: identity.userId,
    environment: speakingEnvironment(authenticated.environment),
  };
}

@Controller()
@UseGuards(ApiKeyUserIdentityGuard)
export class SpeakingGradingJobsController {
  constructor(
    @Inject(SubmitSpeakingGradingJob)
    private readonly submitJob: SubmitSpeakingGradingJob,
    @Inject(GetSpeakingGradingJob)
    private readonly getJob: GetSpeakingGradingJob,
  ) {}

  @Post(PUBLIC_ROUTES['speaking.gradingJobs.create'].path)
  @RequireApiKeyScope(
    PUBLIC_ROUTES['speaking.gradingJobs.create'].requiredScope!,
  )
  @HttpCode(PUBLIC_ROUTES['speaking.gradingJobs.create'].successStatus)
  async submit(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SpeakingGradingJobSubmitResponse> {
    reply.header('Cache-Control', 'no-store');
    const authenticated = getAuthenticatedApiKey(request);
    const identity = request.aihubIdentity;
    if (identity === undefined) throw userIdentityRequired();
    const parsed: SpeakingGradingJobSubmitRequest = parseRequestBody(
      SpeakingGradingJobSubmitRequestSchema,
      body,
      request,
    );
    const lifecycle = getRequestLifecycle(request.raw);
    const requestContext = createRequestContext({
      requestId: String(request.id),
      receivedAt: lifecycle?.receivedAt ?? new Date(),
      ...(lifecycle === undefined ? {} : { signal: lifecycle.signal }),
      deadlineMs:
        PUBLIC_ROUTES['speaking.gradingJobs.create'].timeoutMs ?? 10_000,
      organizationId: authenticated.organizationId,
      apiKeyId: authenticated.apiKeyId,
      environment: authenticated.environment,
      userId: identity.userId,
      identityMode: identity.mode,
      scopes: authenticated.scopes,
    });
    const idempotencyKey = request.headers['idempotency-key'];
    const accepted = await this.submitJob.execute({
      context: requestContext,
      authenticated,
      request: parsed,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    return {
      data: accepted,
      meta: { request_id: requestContext.requestId },
    };
  }

  @Get(PUBLIC_ROUTES['speaking.gradingJobs.get'].path)
  @RequireApiKeyScope(PUBLIC_ROUTES['speaking.gradingJobs.get'].requiredScope!)
  @UseGuards(RateLimitGuard)
  @HttpCode(PUBLIC_ROUTES['speaking.gradingJobs.get'].successStatus)
  async poll(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') jobId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SpeakingGradingJobPollResponse> {
    reply.header('Cache-Control', 'no-store');
    const result = await this.getJob.execute({
      owner: ownerFor(request),
      jobId,
    });
    return {
      data: result,
      meta: { request_id: String(request.id) },
    };
  }
}

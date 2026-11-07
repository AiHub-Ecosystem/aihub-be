import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { FastifyReply } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { invalidRequest } from '@/common/errors/invalid-request';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { appConfig } from '@/config/runtime-configuration';
import {
  type SpeakingGradeJsonInput,
  SpeakingGradeJsonRequestSchema,
  type SpeakingGradeResponse,
} from '@/contracts/speaking/grading';
import type { DispatchResult } from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
  createGradedPipelineContext,
} from '@/modules/gateway/public/graded-pipeline';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import {
  SPEAKING_AUDIO_URL_REJECTION_RECORDER,
  type SpeakingAudioUrlRejectionRecorderPort,
} from '@/modules/speaking/application/speaking-audio-url-rejection-recorder.port';
import { isApprovedSpeakingAudioUrl } from '@/modules/speaking/application/speaking-audio-url.policy';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '@/modules/speaking/application/speaking-multipart-parser.port';
import {
  type InFlightCeiling,
  SPEAKING_UPLOAD_CEILING,
} from '@/modules/speaking/application/speaking-upload-ceiling';
import { createFastifySpeakingMultipartSource } from './fastify-speaking-multipart.source';

const OPERATION = 'speaking.grading' as const;
const JSON_OPERATION = 'speaking.grading-json' as const;

function parseJsonBody(
  body: unknown,
  request: AuthenticatedRequest,
  configuration: ConfigType<typeof appConfig>,
  rejections: SpeakingAudioUrlRejectionRecorderPort,
): SpeakingGradeJsonInput {
  const parsed = parseRequestBody(
    SpeakingGradeJsonRequestSchema,
    body,
    request,
  );
  const policy = isApprovedSpeakingAudioUrl(parsed.audio_url, {
    organizationId: getAuthenticatedApiKey(request).organizationId,
    audioAssetBucket: configuration.SEAWEEDFS_AUDIO_ASSET_BUCKET,
    sampleBucket: configuration.SEAWEEDFS_BUCKET,
  });
  if (!policy.approved) {
    rejections.record(policy.reason);
    throw invalidRequest();
  }

  return {
    audioUrl: parsed.audio_url,
    part: parsed.part,
    questionId: parsed.question_id,
    ...(parsed.prompt_text === undefined
      ? {}
      : { promptText: parsed.prompt_text }),
    // Parsing applies this default; fallback satisfies exact optional types.
    testType: parsed.test_type ?? 'Practice',
    ...(parsed.test_code === undefined ? {} : { testCode: parsed.test_code }),
    ...(parsed.transcript === undefined
      ? {}
      : { transcript: parsed.transcript }),
  };
}

@Controller()
@GradedRequest()
export class SpeakingGradingController {
  constructor(
    @Inject(GRADED_PIPELINE_ENGINE)
    private readonly gradedRequest: GradedPipelineEnginePort,
    @Inject(SPEAKING_MULTIPART_PARSER)
    private readonly multipartParser: SpeakingMultipartParserPort,
    @Inject(SPEAKING_UPLOAD_CEILING)
    private readonly uploadCeiling: InFlightCeiling,
    @Inject(appConfig.KEY)
    private readonly configuration: ConfigType<typeof appConfig>,
    @Inject(SPEAKING_AUDIO_URL_REJECTION_RECORDER)
    private readonly urlRejections: SpeakingAudioUrlRejectionRecorderPort,
  ) {}

  @Post(OPERATION_CATALOG[OPERATION].path)
  @HttpCode(200)
  @RequireOperation(OPERATION)
  async grade(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DispatchResult<SpeakingGradeResponse>> {
    return this.gradedRequest.execute(
      createGradedPipelineContext(request, reply, OPERATION, async (signal) => {
        // Acquire before reading the body, so a refused upload never buffers audio.
        const release = this.uploadCeiling.enter();
        try {
          const source = createFastifySpeakingMultipartSource(request);
          const input = await this.multipartParser.parse(source, signal);
          return { input, release };
        } catch (error) {
          release();
          throw error;
        }
      }),
    );
  }

  @Post(OPERATION_CATALOG[JSON_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(JSON_OPERATION)
  async gradeJson(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DispatchResult<SpeakingGradeResponse>> {
    return this.gradedRequest.execute(
      createGradedPipelineContext(request, reply, JSON_OPERATION, () => ({
        input: parseJsonBody(
          body,
          request,
          this.configuration,
          this.urlRejections,
        ),
      })),
    );
  }
}

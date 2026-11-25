import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  callerIsAuthenticated,
  parseRequestBody,
} from '@/common/http/parsing/parse-request-body';
import {
  type SpeakingGradeJsonInput,
  SpeakingGradeJsonRequestSchema,
  type SpeakingGradeResponse,
} from '@/contracts/speaking/grading';
import type { DispatchResult } from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
  createGradedPipelineContext,
} from '@/modules/gateway/public/graded-pipeline';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { GradedRequest } from '@/modules/identity/shared/presentation/graded-request.decorator';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import {
  RUNTIME_PRESENTATION_CONFIGURATION,
  type RuntimePresentationConfiguration,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import {
  SPEAKING_AUDIO_URL_REJECTION_RECORDER,
  type SpeakingAudioUrlRejectionRecorderPort,
} from '@/modules/speaking/application/audio/speaking-audio-url-rejection-recorder.port';
import { isApprovedSpeakingAudioUrl } from '@/modules/speaking/application/audio/speaking-audio-url.policy';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '@/modules/speaking/application/audio/speaking-multipart-parser.port';
import { SpeakingRecordingAccess } from '@/modules/speaking/application/audio/speaking-recording-access';
import {
  type InFlightCeiling,
  SPEAKING_UPLOAD_CEILING,
} from '@/modules/speaking/application/speaking-upload-ceiling';
import { createFastifySpeakingMultipartSource } from './fastify-speaking-multipart.source';
import { speakingRequestOwner } from './speaking-request-owner';

const OPERATION = 'speaking.grading' as const;
const JSON_OPERATION = 'speaking.grading-json' as const;

interface ParsedJsonBody {
  readonly input: SpeakingGradeJsonInput;
  /** The Audio asset a customer recording URL names; undefined for a catalogue sample. */
  readonly assetId: string | undefined;
}

function parseJsonBody(
  body: unknown,
  request: AuthenticatedRequest,
  configuration: RuntimePresentationConfiguration,
  rejections: SpeakingAudioUrlRejectionRecorderPort,
): ParsedJsonBody {
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
    assetId: policy.assetId,
    input: {
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
    },
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
    @Inject(RUNTIME_PRESENTATION_CONFIGURATION)
    private readonly configuration: RuntimePresentationConfiguration,
    @Inject(SPEAKING_AUDIO_URL_REJECTION_RECORDER)
    private readonly urlRejections: SpeakingAudioUrlRejectionRecorderPort,
    @Inject(SpeakingRecordingAccess)
    private readonly recordings: SpeakingRecordingAccess,
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
          const input = await this.multipartParser.parse(
            source,
            signal,
            callerIsAuthenticated(request),
          );
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
      createGradedPipelineContext(request, reply, JSON_OPERATION, async () => {
        const { input, assetId } = parseJsonBody(
          body,
          request,
          this.configuration,
          this.urlRejections,
        );
        // A customer recording must be a live Audio asset of this End User
        // (ADR-0070). Admission has already run, so a refused lookup is
        // charged to the rate limit like any request; it bills nothing, so it
        // takes no monthly quota (ADR-0018).
        if (assetId !== undefined) {
          await this.recordings.assertLive({
            ...speakingRequestOwner(request),
            assetId,
          });
        }
        return { input };
      }),
    );
  }
}

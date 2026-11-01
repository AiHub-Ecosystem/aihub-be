import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { parseRequestParams } from '@/common/http/parse-request-params';
import type { SpeakingV2PartResult } from '@/contracts/speaking/v2/part-result';
import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import {
  SpeakingV2PartGradeRequestSchema,
  SpeakingV2PartPathSchema,
  SpeakingV2ResponsePathSchema,
  SpeakingV2TestGradeRequestSchema,
  SpeakingV2TestPathSchema,
} from '@/contracts/speaking/v2/requests';
import type { SpeakingV2TestResult } from '@/contracts/speaking/v2/test-result';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  GRADED_REQUEST_EXECUTOR,
  type GradedRequestExecutorPort,
} from '@/modules/gateway/public/graded-request-executor';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '@/modules/speaking/application/speaking-multipart-parser.port';
import {
  type InFlightCeiling,
  SPEAKING_UPLOAD_CEILING,
} from '@/modules/speaking/application/speaking-upload-ceiling';
import { createFastifySpeakingMultipartSource } from './fastify-speaking-multipart.source';

const QUESTION_GRADING = 'speaking.v2.question-grading' as const;
const PART_GRADING = 'speaking.v2.part-grading' as const;
const TEST_GRADING = 'speaking.v2.test-grading' as const;
const RESPONSE_GET = 'speaking.v2.response-get' as const;
const PART_GET = 'speaking.v2.part-get' as const;
const TEST_GET = 'speaking.v2.test-get' as const;

/** The catalog writes a path parameter as `{name}`; Fastify wants `:name`. */
function routePath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, ':$1');
}

@Controller()
@GradedRequest()
export class SpeakingV2Controller {
  constructor(
    @Inject(GRADED_REQUEST_EXECUTOR)
    private readonly gradedRequest: GradedRequestExecutorPort,
    @Inject(SPEAKING_MULTIPART_PARSER)
    private readonly multipartParser: SpeakingMultipartParserPort,
    @Inject(SPEAKING_UPLOAD_CEILING)
    private readonly uploadCeiling: InFlightCeiling,
  ) {}

  @Post(routePath(OPERATION_CATALOG[QUESTION_GRADING].path))
  @HttpCode(200)
  @RequireOperation(QUESTION_GRADING)
  async gradeQuestion(
    @Req() request: AuthenticatedRequest,
  ): Promise<DispatchResult<SpeakingV2QuestionResult>> {
    return this.gradedRequest.execute(
      request,
      QUESTION_GRADING,
      async (signal) => {
        // Acquire before reading the body, so a refused upload never buffers audio.
        const release = this.uploadCeiling.enter();
        try {
          const source = createFastifySpeakingMultipartSource(request);
          const input = await this.multipartParser.parseQuestionV2(
            source,
            signal,
          );
          return { input, release };
        } catch (error) {
          release();
          throw error;
        }
      },
    );
  }

  @Post(routePath(OPERATION_CATALOG[PART_GRADING].path))
  @HttpCode(200)
  @RequireOperation(PART_GRADING)
  async gradePart(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<SpeakingV2PartResult>> {
    return this.gradedRequest.execute(request, PART_GRADING, () => ({
      input: parseRequestBody(SpeakingV2PartGradeRequestSchema, body, request),
    }));
  }

  @Post(routePath(OPERATION_CATALOG[TEST_GRADING].path))
  @HttpCode(200)
  @RequireOperation(TEST_GRADING)
  async gradeTest(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<SpeakingV2TestResult>> {
    return this.gradedRequest.execute(request, TEST_GRADING, () => ({
      input: parseRequestBody(SpeakingV2TestGradeRequestSchema, body, request),
    }));
  }

  @Get(routePath(OPERATION_CATALOG[RESPONSE_GET].path))
  @RequireOperation(RESPONSE_GET)
  async getResponse(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
  ): Promise<DispatchResult<SpeakingV2QuestionResult>> {
    return this.gradedRequest.execute(request, RESPONSE_GET, () => ({
      input: parseRequestParams(SpeakingV2ResponsePathSchema, params),
    }));
  }

  @Get(routePath(OPERATION_CATALOG[PART_GET].path))
  @RequireOperation(PART_GET)
  async getPart(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
  ): Promise<DispatchResult<SpeakingV2PartResult>> {
    return this.gradedRequest.execute(request, PART_GET, () => ({
      input: parseRequestParams(SpeakingV2PartPathSchema, params),
    }));
  }

  @Get(routePath(OPERATION_CATALOG[TEST_GET].path))
  @RequireOperation(TEST_GET)
  async getTest(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
  ): Promise<DispatchResult<SpeakingV2TestResult>> {
    return this.gradedRequest.execute(request, TEST_GET, () => ({
      input: parseRequestParams(SpeakingV2TestPathSchema, params),
    }));
  }
}

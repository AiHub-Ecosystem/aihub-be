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
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

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
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  type GradedPipelineDispatchResult,
  createGradedPipelineContext,
} from '@/modules/gateway/public/graded-pipeline';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '@/modules/speaking/application/speaking-multipart-parser.port';
import { SpeakingV2WorkflowEngine } from '@/modules/speaking/application/speaking-v2-workflow-engine';
import { createFastifySpeakingMultipartSource } from './fastify-speaking-multipart.source';

const QUESTION_GRADING = 'speaking.v2.question-grading' as const;
const PART_GRADING = 'speaking.v2.part-grading' as const;
const TEST_GRADING = 'speaking.v2.test-grading' as const;
const RESPONSE_GET = 'speaking.v2.response-get' as const;
const PART_GET = 'speaking.v2.part-get' as const;
const TEST_GET = 'speaking.v2.test-get' as const;

/** The catalog writes a path parameter as {name}; Fastify wants :name. */
function routePath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, ':$1');
}

@Controller()
@GradedRequest()
export class SpeakingV2Controller {
  constructor(
    @Inject(SpeakingV2WorkflowEngine)
    private readonly workflow: SpeakingV2WorkflowEngine,
    @Inject(SPEAKING_MULTIPART_PARSER)
    private readonly multipartParser: SpeakingMultipartParserPort,
  ) {}

  @Post(routePath(OPERATION_CATALOG[QUESTION_GRADING].path))
  @HttpCode(200)
  @RequireOperation(QUESTION_GRADING)
  async gradeQuestion(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2QuestionResult>> {
    return this.workflow.execute(
      createGradedPipelineContext(
        request,
        reply,
        QUESTION_GRADING,
        async (signal) => {
          const source = createFastifySpeakingMultipartSource(request);
          const input = await this.multipartParser.parseQuestionV2(
            source,
            signal,
          );
          return { input };
        },
      ),
    );
  }

  @Post(routePath(OPERATION_CATALOG[PART_GRADING].path))
  @HttpCode(200)
  @RequireOperation(PART_GRADING)
  async gradePart(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2PartResult>> {
    return this.workflow.execute(
      createGradedPipelineContext(request, reply, PART_GRADING, async () => ({
        input: parseRequestBody(
          SpeakingV2PartGradeRequestSchema,
          body,
          request,
        ),
      })),
    );
  }

  @Post(routePath(OPERATION_CATALOG[TEST_GRADING].path))
  @HttpCode(200)
  @RequireOperation(TEST_GRADING)
  async gradeTest(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2TestResult>> {
    return this.workflow.execute(
      createGradedPipelineContext(request, reply, TEST_GRADING, async () => ({
        input: parseRequestBody(
          SpeakingV2TestGradeRequestSchema,
          body,
          request,
        ),
      })),
    );
  }

  @Get(routePath(OPERATION_CATALOG[RESPONSE_GET].path))
  @RequireOperation(RESPONSE_GET)
  async getResponse(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2QuestionResult>> {
    return this.workflow.execute(
      createGradedPipelineContext(request, reply, RESPONSE_GET, async () => ({
        input: parseRequestParams(SpeakingV2ResponsePathSchema, params),
      })),
    );
  }

  @Get(routePath(OPERATION_CATALOG[PART_GET].path))
  @RequireOperation(PART_GET)
  async getPart(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2PartResult>> {
    return this.workflow.execute(
      createGradedPipelineContext(request, reply, PART_GET, async () => ({
        input: parseRequestParams(SpeakingV2PartPathSchema, params),
      })),
    );
  }

  @Get(routePath(OPERATION_CATALOG[TEST_GET].path))
  @RequireOperation(TEST_GET)
  async getTest(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GradedPipelineDispatchResult<SpeakingV2TestResult>> {
    return this.workflow.execute(
      createGradedPipelineContext(request, reply, TEST_GET, async () => ({
        input: parseRequestParams(SpeakingV2TestPathSchema, params),
      })),
    );
  }
}

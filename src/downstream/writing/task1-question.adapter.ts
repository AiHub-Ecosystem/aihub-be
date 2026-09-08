import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { AppError } from '../../common/errors/app-error';
import type {
  Task1QuestionRequest,
  Task1QuestionResponse,
} from '../../contracts/writing/task1';
import { ChartTypeSchema } from '../../contracts/writing/task1';
import type { DownstreamAdapter } from '../downstream-adapter';
import type {
  DownstreamRequest,
  InternalAIServiceResponse,
} from '../downstream.types';

const DownstreamQuestionPayloadSchema = Type.Object(
  {
    question_id: Type.String({ minLength: 1 }),
    topic: ChartTypeSchema,
    question: Type.String({ minLength: 1 }),
    image_url: Type.String({ format: 'uri' }),
  },
  { additionalProperties: true },
);

const DownstreamQuestionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        data: DownstreamQuestionPayloadSchema,
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

type DownstreamQuestionResponse = Static<
  typeof DownstreamQuestionResponseSchema
>;

function contractViolation(reason: string): AppError {
  return new AppError({
    code: 'AI_SERVICE_CONTRACT_VIOLATION',
    message: 'AI service returned an unexpected response shape',
    retryable: false,
    cause: new Error(reason),
  });
}

function parseDownstreamResponse(
  response: InternalAIServiceResponse<unknown>,
): DownstreamQuestionResponse {
  if (!Value.Check(DownstreamQuestionResponseSchema, response.body)) {
    throw contractViolation('missing data.data question payload');
  }

  return Value.Parse(DownstreamQuestionResponseSchema, response.body);
}

export const task1QuestionAdapter: DownstreamAdapter<
  Task1QuestionRequest,
  Task1QuestionResponse
> = {
  operation: 'writing.task1.question.generate',
  downstream: 'ai-writing',

  buildRequest(input: Task1QuestionRequest, context): DownstreamRequest {
    void context;

    return {
      method: 'POST',
      path: '/generate-question-task1',
      body: input.chart_type === undefined ? {} : { topic: input.chart_type },
      contentType: 'application/json',
    };
  },

  parseResponse(
    response: InternalAIServiceResponse<unknown>,
  ): Task1QuestionResponse {
    const payload = parseDownstreamResponse(response).data.data;

    return {
      question_id: payload.question_id,
      question: payload.question,
      chart_type: payload.topic,
      image_url: payload.image_url,
    };
  },
};

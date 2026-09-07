import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { AppError } from '../../common/errors/app-error';
import type {
  Task2QuestionRequest,
  Task2QuestionResponse,
} from '../../contracts/writing/task2';
import { QuestionTypeSchema } from '../../contracts/writing/task2';
import type { DownstreamAdapter } from '../downstream-adapter';
import type {
  DownstreamRequest,
  InternalAIServiceResponse,
} from '../downstream.types';

// Envelope is flat, unlike Task 1's doubly-nested `data.data` — one more
// naming inconsistency the adapter absorbs so the public contract stays
// symmetric between the two tasks.
const DownstreamQuestionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        description: Type.String({ minLength: 1 }),
        instruction: QuestionTypeSchema,
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
    httpStatus: 502,
    retryable: false,
    cause: new Error(reason),
  });
}

function parseDownstreamResponse(
  response: InternalAIServiceResponse<unknown>,
): DownstreamQuestionResponse {
  if (!Value.Check(DownstreamQuestionResponseSchema, response.body)) {
    throw contractViolation('missing data.description or data.instruction');
  }

  return Value.Parse(DownstreamQuestionResponseSchema, response.body);
}

export const task2QuestionAdapter: DownstreamAdapter<
  Task2QuestionRequest,
  Task2QuestionResponse
> = {
  operation: 'writing.task2.question.generate',
  downstream: 'ai-writing',

  buildRequest(input: Task2QuestionRequest, context): DownstreamRequest {
    void context;

    return {
      method: 'POST',
      path: '/question-generated-task2',
      body: { topic: input.topic, question_type: input.question_type },
      contentType: 'application/json',
    };
  },

  parseResponse(
    response: InternalAIServiceResponse<unknown>,
  ): Task2QuestionResponse {
    const payload = parseDownstreamResponse(response).data;

    return {
      question: payload.description,
      // Downstream never echoes the subject back; the public contract keeps
      // the field rather than dropping it, so it stays empty here.
      topic: '',
      question_type: payload.instruction,
    };
  },
};

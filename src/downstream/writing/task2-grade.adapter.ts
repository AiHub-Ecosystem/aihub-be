import type {
  GradeResponse,
  GradeTask2Request,
} from '@/contracts/writing/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import { parseGradeResponse } from './grade-response.adapter';

export const task2GradeAdapter: DownstreamAdapter<
  GradeTask2Request,
  GradeResponse
> = {
  operation: 'writing.task2.grade',
  downstream: 'ai-writing',

  buildRequest(input: GradeTask2Request, context): DownstreamRequest {
    void context;

    return {
      method: 'POST',
      path: '/grading-feedback-task2',
      body: {
        question: input.question,
        topic: input.topic,
        essay: input.essay,
      },
      contentType: 'application/json',
    };
  },

  parseResponse(response): GradeResponse {
    return parseGradeResponse(response.body);
  },
};

import type {
  GradeResponse,
  GradeTask1Request,
} from '@/contracts/writing/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import { parseGradeResponse } from './grade-response.adapter';

export const task1GradeAdapter: DownstreamAdapter<
  GradeTask1Request,
  GradeResponse
> = {
  operation: 'writing.task1.grade',
  downstream: 'ai-writing',

  buildRequest(input: GradeTask1Request, context): DownstreamRequest {
    void context;

    return {
      method: 'POST',
      path: '/grading-feedback-task1',
      body: {
        question: input.question,
        // Downstream calls the chart type `topic` and the image `url`.
        topic: input.chart_type,
        essay: input.essay,
        url: input.image_url,
      },
      contentType: 'application/json',
    };
  },

  parseResponse(response): GradeResponse {
    return parseGradeResponse(response.body);
  },
};

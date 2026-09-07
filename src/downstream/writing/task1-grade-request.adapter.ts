import type { RequestContext } from '../../common/request-context/request-context';
import type { GradeTask1Request } from '../../contracts/writing/grading';
import type { DownstreamRequestAdapter } from '../downstream-adapter';
import type { DownstreamRequest } from '../downstream.types';

export const task1GradeRequestAdapter: DownstreamRequestAdapter<GradeTask1Request> =
  {
    operation: 'writing.task1.grade',
    downstream: 'ai-writing',
    buildRequest(
      input: GradeTask1Request,
      context: RequestContext,
    ): DownstreamRequest {
      void context;

      return {
        method: 'POST',
        path: '/grading-feedback-task1',
        body: {
          question: input.question,
          url: input.image_url,
          topic: input.topic,
          essay: input.essay,
        },
        contentType: 'application/json',
      };
    },
  };

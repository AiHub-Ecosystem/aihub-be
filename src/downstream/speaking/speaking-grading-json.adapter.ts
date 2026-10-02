import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingGradeJsonInput,
  SpeakingGradeResponse,
} from '@/contracts/speaking/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import { parseSpeakingGradeResponse } from './speaking-grading-response.adapter';
import { requiredSpeakingUserId } from './speaking-grading.adapter';

function appendOptional(
  body: Record<string, unknown>,
  name: string,
  value: string | null | undefined,
): void {
  if (value !== undefined) {
    body[name] = value;
  }
}

export const speakingGradingJsonAdapter: DownstreamAdapter<
  SpeakingGradeJsonInput,
  SpeakingGradeResponse
> = {
  operation: 'speaking.grading-json',
  downstream: 'ai-speaking',

  buildRequest(
    input: SpeakingGradeJsonInput,
    context: RequestContext,
  ): DownstreamRequest {
    const body: Record<string, unknown> = {
      user_id: requiredSpeakingUserId(context),
      part: input.part,
      question_id: input.questionId,
      audio_url: input.audioUrl,
      test_type: input.testType ?? 'Practice',
    };
    appendOptional(body, 'prompt_text', input.promptText);
    appendOptional(body, 'test_code', input.testCode);
    appendOptional(body, 'transcript', input.transcript);

    return {
      method: 'POST',
      path: OPERATION_CATALOG['speaking.grading-json'].downstreamPath,
      body,
    };
  },

  parseResponse(response): SpeakingGradeResponse {
    return parseSpeakingGradeResponse(response.body);
  },
};

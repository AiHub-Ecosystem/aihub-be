import { OPERATION_CATALOG } from '../../catalog/operation-catalog';
import { AppError } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/request-context/request-context';
import type {
  SpeakingGradeInput,
  SpeakingGradeResponse,
} from '../../contracts/speaking/grading';
import type { DownstreamAdapter } from '../downstream-adapter';
import type {
  DownstreamMultipartBody,
  DownstreamRequest,
} from '../downstream.types';
import { parseSpeakingGradeResponse } from './speaking-grading-response.adapter';

export function requiredSpeakingUserId(context: RequestContext): string {
  const userId = context.userId;
  if (userId === undefined || userId.trim().length === 0) {
    throw new AppError({
      code: 'USER_IDENTITY_REQUIRED',
      message: 'User identity is required in X-User-Identity',
      retryable: false,
    });
  }
  return userId;
}

function appendOptional(
  fields: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    fields[name] = value;
  }
}

export const speakingGradingAdapter: DownstreamAdapter<
  SpeakingGradeInput,
  SpeakingGradeResponse
> = {
  operation: 'speaking.grading',
  downstream: 'ai-speaking',

  buildRequest(
    input: SpeakingGradeInput,
    context: RequestContext,
  ): DownstreamRequest {
    const fields: Record<string, string> = {
      user_id: requiredSpeakingUserId(context),
      part: String(input.part),
      question_id: input.questionId,
    };
    appendOptional(fields, 'prompt_text', input.promptText);
    appendOptional(fields, 'test_type', input.testType);
    appendOptional(fields, 'test_code', input.testCode);
    appendOptional(fields, 'transcript', input.transcript);

    const body: DownstreamMultipartBody = {
      kind: 'multipart',
      fields,
      file: {
        fieldName: 'audio',
        bytes: input.audio.bytes,
        filename: input.audio.filename,
        contentType: input.audio.contentType || 'application/octet-stream',
      },
    };

    return {
      method: 'POST',
      path: OPERATION_CATALOG['speaking.grading'].downstreamPath,
      body,
    };
  },

  parseResponse(response): SpeakingGradeResponse {
    return parseSpeakingGradeResponse(response.body);
  },
};

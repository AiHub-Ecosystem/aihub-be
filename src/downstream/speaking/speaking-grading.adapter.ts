import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { AppError } from '@/common/errors/app-error';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingGradeInput,
  SpeakingGradeResponse,
} from '@/contracts/speaking/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type {
  DownstreamErrorHint,
  DownstreamIdentityHeaders,
  DownstreamMultipartBody,
  DownstreamRequest,
} from '@/downstream/downstream.types';
import { parseSpeakingGradeResponse } from './speaking-grading-response.adapter';

const SPEAKING_IDENTITY_CONTEXT_ERROR_CODE = 'INTERNAL_ERROR';

export function requiredSpeakingUserId(context: RequestContext): string {
  const userId = context.userId;
  if (userId === undefined || userId.trim().length === 0) {
    throw userIdentityRequired();
  }
  return userId;
}

export function requiredSpeakingIdentityHeaders(
  context: RequestContext,
): DownstreamIdentityHeaders {
  const organizationId = context.organizationId;
  if (organizationId === undefined || organizationId.trim().length === 0) {
    throw new AppError({
      code: SPEAKING_IDENTITY_CONTEXT_ERROR_CODE,
      message: 'Speaking identity context is incomplete',
      retryable: false,
    });
  }

  const identityMode = context.identityMode;
  if (identityMode !== 'declared_id' && identityMode !== 'signed_assertion') {
    throw new AppError({
      code: SPEAKING_IDENTITY_CONTEXT_ERROR_CODE,
      message: 'Speaking identity context is incomplete',
      retryable: false,
    });
  }

  return {
    'x-aihub-organization-id': organizationId,
    'x-aihub-user-id': requiredSpeakingUserId(context),
    'x-aihub-user-identity-mode': identityMode,
  };
}

/**
 * The provider answers audio it cannot decode with a 500 whose FastAPI
 * `detail` carries this marker (captured in
 * test/fixtures/ai-speaking/grading-convert-audio.500.json, #247). That is the
 * caller's file, not a provider outage, so retrying cannot help. No other
 * marker is mapped until it has been captured the same way.
 */
const UNREADABLE_AUDIO_MARKER = '[error_convert_audio]';

export function parseSpeakingGradingError(
  status: number,
  body: unknown,
): DownstreamErrorHint | undefined {
  if (
    status >= 500 &&
    typeof body === 'object' &&
    body !== null &&
    'detail' in body &&
    typeof body.detail === 'string' &&
    body.detail.includes(UNREADABLE_AUDIO_MARKER)
  ) {
    return {
      code: 'AUDIO_UNREADABLE',
      message:
        'The audio could not be read; upload a valid recording in a supported format',
      retryable: false,
    };
  }
  return undefined;
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
        blob: input.audio.blob,
        filename: input.audio.filename,
        contentType: input.audio.contentType || 'application/octet-stream',
      },
    };

    return {
      method: 'POST',
      path: OPERATION_CATALOG['speaking.grading'].downstreamPath,
      headers: requiredSpeakingIdentityHeaders(context),
      body,
    };
  },

  parseResponse(response): SpeakingGradeResponse {
    return parseSpeakingGradeResponse(response.body);
  },

  parseError: parseSpeakingGradingError,
};

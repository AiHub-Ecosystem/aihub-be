import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingV2PartGradeInput,
  SpeakingV2PartPath,
  SpeakingV2QuestionGradeInput,
  SpeakingV2ResponsePath,
  SpeakingV2TestGradeInput,
  SpeakingV2TestPath,
} from '@/contracts/speaking/v2/inputs';
import type { SpeakingV2PartResult } from '@/contracts/speaking/v2/part-result';
import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import type { SpeakingV2TestResult } from '@/contracts/speaking/v2/test-result';
import { toProviderSpeakingTestType } from '@/contracts/speaking/v2/test-type';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type {
  DownstreamMultipartBody,
  DownstreamRequest,
} from '@/downstream/downstream.types';
import { requiredSpeakingIdentityHeaders } from './speaking-grading.adapter';
import { parseSpeakingV2ProviderError } from './speaking-v2-error.adapter';
import { parseSpeakingV2PartResult } from './speaking-v2-part-response.adapter';
import { parseSpeakingV2QuestionResult } from './speaking-v2-question-response.adapter';
import { parseSpeakingV2TestResult } from './speaking-v2-test-response.adapter';

// v2.4 reads the Organization and End-User from the identity headers; its
// requests carry no `user_id` (contract v2.4 section 3).
function parseError(status: number, body: unknown) {
  return status >= 400 ? parseSpeakingV2ProviderError(body) : undefined;
}

function readRequest(path: string, context: RequestContext): DownstreamRequest {
  return {
    method: 'GET',
    path,
    headers: requiredSpeakingIdentityHeaders(context),
  };
}

function jsonRequest(
  path: string,
  context: RequestContext,
  body: Record<string, unknown>,
): DownstreamRequest {
  return {
    method: 'POST',
    path,
    headers: requiredSpeakingIdentityHeaders(context),
    body,
  };
}

function withProviderTestType<
  T extends { readonly test_type?: 'practice' | 'full_test' },
>(
  input: T,
): Omit<T, 'test_type'> & { readonly test_type?: 'Practice' | 'Full-test' } {
  const { test_type, ...rest } = input;
  return test_type === undefined
    ? rest
    : { ...rest, test_type: toProviderSpeakingTestType(test_type) };
}

export const speakingV2QuestionGradingAdapter: DownstreamAdapter<
  SpeakingV2QuestionGradeInput,
  SpeakingV2QuestionResult
> = {
  operation: 'speaking.v2.question-grading',
  downstream: 'ai-speaking',

  buildRequest(input, context): DownstreamRequest {
    const fields: Record<string, string> = {
      part: String(input.part),
      question_id: input.questionId,
    };
    if (input.promptText !== undefined) fields.prompt_text = input.promptText;
    if (input.testType !== undefined) {
      fields.test_type = toProviderSpeakingTestType(input.testType);
    }
    if (input.testCode !== undefined) fields.test_code = input.testCode;
    if (input.partResultId !== undefined) {
      fields.part_result_id = input.partResultId;
    }

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
      path: OPERATION_CATALOG['speaking.v2.question-grading'].downstreamPath,
      headers: requiredSpeakingIdentityHeaders(context),
      body,
    };
  },

  parseResponse: (response) => parseSpeakingV2QuestionResult(response.body),
  parseError,
};

export const speakingV2PartGradingAdapter: DownstreamAdapter<
  SpeakingV2PartGradeInput,
  SpeakingV2PartResult
> = {
  operation: 'speaking.v2.part-grading',
  downstream: 'ai-speaking',
  buildRequest: (input, context) =>
    jsonRequest(
      OPERATION_CATALOG['speaking.v2.part-grading'].downstreamPath,
      context,
      withProviderTestType(input),
    ),
  parseResponse: (response) => parseSpeakingV2PartResult(response.body),
  parseError,
};

export const speakingV2TestGradingAdapter: DownstreamAdapter<
  SpeakingV2TestGradeInput,
  SpeakingV2TestResult
> = {
  operation: 'speaking.v2.test-grading',
  downstream: 'ai-speaking',
  buildRequest: (input, context) =>
    jsonRequest(
      OPERATION_CATALOG['speaking.v2.test-grading'].downstreamPath,
      context,
      withProviderTestType(input),
    ),
  parseResponse: (response) => parseSpeakingV2TestResult(response.body),
  parseError,
};

export const speakingV2ResponseGetAdapter: DownstreamAdapter<
  SpeakingV2ResponsePath,
  SpeakingV2QuestionResult
> = {
  operation: 'speaking.v2.response-get',
  downstream: 'ai-speaking',
  buildRequest: (input, context) =>
    readRequest(
      OPERATION_CATALOG['speaking.v2.response-get'].downstreamPath.replace(
        '{response_id}',
        encodeURIComponent(input.response_id),
      ),
      context,
    ),
  parseResponse: (response) => parseSpeakingV2QuestionResult(response.body),
  parseError,
};

export const speakingV2PartGetAdapter: DownstreamAdapter<
  SpeakingV2PartPath,
  SpeakingV2PartResult
> = {
  operation: 'speaking.v2.part-get',
  downstream: 'ai-speaking',
  buildRequest: (input, context) =>
    readRequest(
      OPERATION_CATALOG['speaking.v2.part-get'].downstreamPath.replace(
        '{part_result_id}',
        encodeURIComponent(input.part_result_id),
      ),
      context,
    ),
  parseResponse: (response) => parseSpeakingV2PartResult(response.body),
  parseError,
};

export const speakingV2TestGetAdapter: DownstreamAdapter<
  SpeakingV2TestPath,
  SpeakingV2TestResult
> = {
  operation: 'speaking.v2.test-get',
  downstream: 'ai-speaking',
  buildRequest: (input, context) =>
    readRequest(
      OPERATION_CATALOG['speaking.v2.test-get'].downstreamPath.replace(
        '{test_id}',
        encodeURIComponent(input.test_id),
      ),
      context,
    ),
  parseResponse: (response) => parseSpeakingV2TestResult(response.body),
  parseError,
};

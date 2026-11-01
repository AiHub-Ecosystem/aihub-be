import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  WritingV2GradeResponse,
  WritingV2GradeTask1Request,
  WritingV2GradeTask2Request,
} from '@/contracts/writing/v2/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type {
  DownstreamIdentityHeaders,
  DownstreamRequest,
} from '@/downstream/downstream.types';
import { requiredSpeakingIdentityHeaders } from '@/downstream/speaking/speaking-grading.adapter';
import { parseWritingV3ProviderError } from './writing-v3-error.adapter';
import { providerOrganizationId } from './writing-v3-organization-id';
import { parseWritingV3Response } from './writing-v3-response.adapter';

/**
 * The same three identity headers `/v2` Speaking sends (ADR-0140 decision 2),
 * except that v3 accepts only a UUID Organization ID, so it carries the derived
 * one (ADR-0143 decision 13). Presence and mode checks are shared with Speaking.
 */
function writingV3IdentityHeaders(
  context: RequestContext,
): DownstreamIdentityHeaders {
  const headers = requiredSpeakingIdentityHeaders(context);
  return {
    ...headers,
    'x-aihub-organization-id': providerOrganizationId(
      headers['x-aihub-organization-id'],
    ),
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
    headers: writingV3IdentityHeaders(context),
    body,
    contentType: 'application/json',
  };
}

export const writingV3Task1GradeAdapter: DownstreamAdapter<
  WritingV2GradeTask1Request,
  WritingV2GradeResponse
> = {
  operation: 'writing.v2.task1.grade',
  downstream: 'ai-writing',

  buildRequest(input, context): DownstreamRequest {
    return jsonRequest(
      OPERATION_CATALOG['writing.v2.task1.grade'].downstreamPath,
      context,
      {
        question: input.question,
        // The provider calls the chart type `topic` and the image `url`.
        topic: input.chart_type,
        essay: input.essay,
        url: input.image_url,
      },
    );
  },

  parseResponse: (response) => parseWritingV3Response(response.body),
  parseError: parseWritingV3ProviderError,
};

export const writingV3Task2GradeAdapter: DownstreamAdapter<
  WritingV2GradeTask2Request,
  WritingV2GradeResponse
> = {
  operation: 'writing.v2.task2.grade',
  downstream: 'ai-writing',

  buildRequest(input, context): DownstreamRequest {
    return jsonRequest(
      OPERATION_CATALOG['writing.v2.task2.grade'].downstreamPath,
      context,
      {
        question: input.question,
        topic: input.topic,
        essay: input.essay,
      },
    );
  },

  parseResponse: (response) => parseWritingV3Response(response.body),
  parseError: parseWritingV3ProviderError,
};

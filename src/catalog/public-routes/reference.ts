import type { OpenApiParameterMetadata } from '@/catalog/openapi-operation-metadata';
import {
  ListeningTestsResponseSchema,
  ReadingTestsResponseSchema,
} from '@/contracts/practice/v2/tests';
import {
  SpeakingQuestionsQuerySchema,
  SpeakingQuestionsResponseSchema,
} from '@/contracts/speaking/questions';
import { SpeakingLibraryResponseSchema } from '@/contracts/speaking/v2/library';
import {
  WritingTask1TemplatesResponseSchema,
  WritingTask2TemplatesResponseSchema,
} from '@/contracts/writing/v2/templates';

/** Paging query parameters for /v2 practice content collections (ADR-0130). */
const PRACTICE_CONTENT_QUERY_PARAMETERS: readonly OpenApiParameterMetadata[] = [
  {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Number of items to return (1..200, default 20).',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
  },
  {
    name: 'cursor',
    in: 'query',
    required: false,
    description: 'Opaque pagination cursor from a previous page.',
    schema: { type: 'string', minLength: 1 },
  },
];

export const REFERENCE_PUBLIC_ROUTES = {
  'speaking.questions': {
    cacheControl: {
      value: 'no-store',
      description: 'This response must not be cached.',
    },
    openApi: {
      summary: 'List Speaking questions',
      includeCorrelationId: false,
      parameters: [
        {
          name: 'part',
          in: 'query',
          required: false,
          description: 'Filter by Speaking part; omit to list all parts.',
          schema: SpeakingQuestionsQuerySchema.properties.part,
        },
      ],
      successDescription: 'Speaking questions and signed audio URLs',
    },
    method: 'GET',
    path: '/v1/ielts/speaking/questions',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingQuestionsResponseSchema,
    errorStatuses: [400, 500, 503],
  },
  'writing.v2.task1.templates': {
    cacheControl: {
      value: 'no-store',
      description: 'This response must not be cached.',
    },
    openApi: {
      summary: 'List Writing Task 1 templates',
      includeCorrelationId: false,
      parameters: PRACTICE_CONTENT_QUERY_PARAMETERS,
      successDescription:
        'List of Writing Task 1 templates with cursor pagination',
    },
    method: 'GET',
    path: '/v2/ielts/writing/task1/templates',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: WritingTask1TemplatesResponseSchema,
    errorStatuses: [400, 500, 502, 503, 504],
  },
  'writing.v2.task2.templates': {
    cacheControl: {
      value: 'no-store',
      description: 'This response must not be cached.',
    },
    openApi: {
      summary: 'List Writing Task 2 templates',
      includeCorrelationId: false,
      parameters: PRACTICE_CONTENT_QUERY_PARAMETERS,
      successDescription:
        'List of Writing Task 2 templates with cursor pagination',
    },
    method: 'GET',
    path: '/v2/ielts/writing/task2/templates',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: WritingTask2TemplatesResponseSchema,
    errorStatuses: [400, 500, 502, 503, 504],
  },
  'speaking.v2.library': {
    cacheControl: {
      value: 'no-store',
      description: 'This response must not be cached.',
    },
    openApi: {
      summary: 'List Speaking library topics',
      includeCorrelationId: false,
      parameters: PRACTICE_CONTENT_QUERY_PARAMETERS,
      successDescription:
        'List of Speaking library topics with cursor pagination',
    },
    method: 'GET',
    path: '/v2/ielts/speaking/library',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingLibraryResponseSchema,
    errorStatuses: [400, 500, 502, 503, 504],
  },
  'listening.v2.tests': {
    cacheControl: {
      value: 'no-store',
      description: 'This response must not be cached.',
    },
    openApi: {
      summary: 'List Listening tests',
      includeCorrelationId: false,
      parameters: PRACTICE_CONTENT_QUERY_PARAMETERS,
      successDescription: 'List of Listening tests with cursor pagination',
    },
    method: 'GET',
    path: '/v2/ielts/listening/tests',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListeningTestsResponseSchema,
    errorStatuses: [400, 500, 502, 503, 504],
  },
  'reading.v2.tests': {
    cacheControl: {
      value: 'no-store',
      description: 'This response must not be cached.',
    },
    openApi: {
      summary: 'List Reading tests',
      includeCorrelationId: false,
      parameters: PRACTICE_CONTENT_QUERY_PARAMETERS,
      successDescription: 'List of Reading tests with cursor pagination',
    },
    method: 'GET',
    path: '/v2/ielts/reading/tests',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadingTestsResponseSchema,
    errorStatuses: [400, 500, 502, 503, 504],
  },
} as const;

import type { TSchema } from '@sinclair/typebox';

import type { ErrorCode } from '@/common/errors/error-code';
import type {
  CacheControlPolicy,
  OpenApiOperationMetadata,
} from './openapi-operation-metadata';

import {
  SpeakingGradeJsonRequestSchema,
  SpeakingGradeRequestSchema,
  SpeakingGradeResponseSchema,
} from '@/contracts/speaking/grading';
import { SpeakingV2PartResultSchema } from '@/contracts/speaking/v2/part-result';
import { SpeakingV2QuestionResultSchema } from '@/contracts/speaking/v2/question-result';
import {
  SpeakingV2PartGradeRequestSchema,
  SpeakingV2PartPathSchema,
  SpeakingV2QuestionGradeMultipartSchema,
  SpeakingV2ResponsePathSchema,
  SpeakingV2TestGradeRequestSchema,
  SpeakingV2TestPathSchema,
} from '@/contracts/speaking/v2/requests';
import { SpeakingV2TestResultSchema } from '@/contracts/speaking/v2/test-result';
import {
  GradeResponseSchema,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '@/contracts/writing/grading';
import {
  CreateLongWritingExerciseRequestSchema,
  CreateMicroExerciseRequestSchema,
  GradeMicroExerciseRequestSchema,
  LongWritingExerciseResponseSchema,
  MicroExerciseGradeResponseSchema,
  MicroExerciseResponseSchema,
} from '@/contracts/writing/v2/exercises';
import {
  WritingV2GradeResponseSchema,
  WritingV2GradeTask1RequestSchema,
  WritingV2GradeTask2RequestSchema,
} from '@/contracts/writing/v2/grading';
import type { DownstreamId } from '@/downstream/downstream.types';

// 'organization' is not an identity scope here and is not coming back.
// Identity scope describes which User Identity form an operation consumes, and
// no non-dispatch Public API Route consumes one: they authenticate with a Bearer
// User Access JWT, a refresh cookie, an API key, or nothing, and take their
// Organization from the route. A route that dispatches nothing lives in
// `public-routes.ts` instead, because widening `OperationId` with non-dispatch
// ids would force a `dispatch()` overload per route (ADR-0059).
type IdentityScope = 'user';
export type IdempotencyMode = 'none' | 'optional' | 'required';
export type MeteringMode = 'model' | 'none';
type ResponseContract = TSchema | 'unresolved';

// The most response body AIHUB reads from an AI Service for one operation. An
// AI Service answer is untrusted input and the container is small, so a body
// past the limit is cancelled and refused as AI_SERVICE_CONTRACT_VIOLATION
// (#377). Each limit is at least nine times the largest captured response of its
// family; the measurements and the reasoning live in the README beside the
// fixtures, and raising a limit means re-measuring there first.
const WRITING_RESPONSE_MAX_BYTES = 256 * 1024;
const SPEAKING_RESPONSE_MAX_BYTES = 1024 * 1024;

// The one canonical Task 1 sample chart URL. The AI Writing service fetches
// the image itself, outside the customer's request, so it is published rather
// than signed (ADR-0060). Postman, the integration guide, and the drift guard
// in `operation-catalog.spec.ts` all name this constant; nobody repeats the
// literal.
export const TASK1_SAMPLE_IMAGE_URL =
  'https://s3.wispace.app/ielts-task1/ca95bd4ab522946d';

interface OperationDefBase {
  readonly openApi: OpenApiOperationMetadata;
  readonly cacheControl?: CacheControlPolicy;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly requiredScope: string;
  readonly identityScope: IdentityScope;
  readonly execution: 'sync';
  readonly idempotency: IdempotencyMode;
  readonly family: 'writing' | 'speaking';
  readonly meteringMode: MeteringMode;
  readonly maxBodyBytes: number;
  /** Ceiling on the AI Service response body read for this operation. */
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly downstream: DownstreamId;
  readonly downstreamPath: string;
  readonly responseContract: ResponseContract;
  /**
   * Public codes this operation's adapter names from a provider failure body
   * (`parseError`). Only these operations publish the codes, so a code one
   * provider can raise is not advertised on every graded route.
   */
  readonly namedDownstreamErrors?: readonly ErrorCode[];
}

export type OperationDef = OperationDefBase &
  (
    | {
        readonly method: 'POST';
        readonly contentType: 'application/json' | 'multipart/form-data';
        readonly requestSchema: TSchema;
        readonly pathParamsSchema?: never;
      }
    | {
        readonly method: 'GET';
        readonly contentType?: never;
        readonly requestSchema?: never;
        readonly pathParamsSchema: TSchema;
        readonly idempotency: 'none';
        readonly meteringMode: 'none';
        readonly maxBodyBytes: 0;
      }
  );

export const OPERATION_CATALOG = {
  'writing.task1.grade': {
    openApi: { summary: 'Grade a Writing Task 1 essay' },
    method: 'POST',
    path: '/v1/ielts/writing/task1/grade',
    requiredScope: 'writing.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    family: 'writing',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 60_000,
    maxResponseBytes: WRITING_RESPONSE_MAX_BYTES,
    downstream: 'ai-writing',
    downstreamPath: '/v1/grading-feedback-task1',
    requestSchema: GradeTask1RequestSchema,
    responseContract: GradeResponseSchema,
  },
  'writing.task2.grade': {
    openApi: { summary: 'Grade a Writing Task 2 essay' },
    method: 'POST',
    path: '/v1/ielts/writing/task2/grade',
    requiredScope: 'writing.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    family: 'writing',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 60_000,
    maxResponseBytes: WRITING_RESPONSE_MAX_BYTES,
    downstream: 'ai-writing',
    downstreamPath: '/v1/grading-feedback-task2',
    requestSchema: GradeTask2RequestSchema,
    responseContract: GradeResponseSchema,
  },
  'writing.v2.task1.grade': {
    openApi: { summary: 'Grade a Writing Task 1 essay' },
    method: 'POST',
    path: '/v2/ielts/writing/task1/grade',
    requiredScope: 'writing.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    family: 'writing',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    // The provider's v3 pipeline takes 30 to 45 s and gives up at 120 s with
    // its own 504. 125 s lets AIHUB answer that 504 as AI_SERVICE_TIMEOUT; the
    // edge allows 135 s (ADR-0143 decisions 5 and 7).
    timeoutMs: 125_000,
    maxResponseBytes: WRITING_RESPONSE_MAX_BYTES,
    downstream: 'ai-writing',
    downstreamPath: '/v3/grading-feedback-task1',
    requestSchema: WritingV2GradeTask1RequestSchema,
    responseContract: WritingV2GradeResponseSchema,
  },
  'writing.v2.task2.grade': {
    openApi: { summary: 'Grade a Writing Task 2 essay' },
    method: 'POST',
    path: '/v2/ielts/writing/task2/grade',
    requiredScope: 'writing.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    family: 'writing',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 125_000,
    maxResponseBytes: WRITING_RESPONSE_MAX_BYTES,
    downstream: 'ai-writing',
    downstreamPath: '/v3/grading-feedback-task2',
    requestSchema: WritingV2GradeTask2RequestSchema,
    responseContract: WritingV2GradeResponseSchema,
  },
  'writing.v2.micro-exercises.create': {
    openApi: { summary: 'Create Writing micro-exercises' },
    method: 'POST',
    path: '/v2/ielts/writing/micro-exercises',
    requiredScope: 'writing.exercise',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    family: 'writing',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 45_000,
    maxResponseBytes: WRITING_RESPONSE_MAX_BYTES,
    downstream: 'ai-writing',
    downstreamPath: '/v2/create-micro-exercise',
    requestSchema: CreateMicroExerciseRequestSchema,
    responseContract: MicroExerciseResponseSchema,
    namedDownstreamErrors: ['INVALID_REQUEST'],
  },
  'writing.v2.long-writing-exercises.create': {
    openApi: { summary: 'Create a long Writing exercise' },
    method: 'POST',
    path: '/v2/ielts/writing/long-writing-exercises',
    requiredScope: 'writing.exercise',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    family: 'writing',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 35_000,
    maxResponseBytes: WRITING_RESPONSE_MAX_BYTES,
    downstream: 'ai-writing',
    downstreamPath: '/v2/create-longwriting-exercise',
    requestSchema: CreateLongWritingExerciseRequestSchema,
    responseContract: LongWritingExerciseResponseSchema,
    namedDownstreamErrors: ['INVALID_REQUEST'],
  },
  'writing.v2.micro-exercises.grade': {
    openApi: { summary: 'Grade a Writing micro-exercise' },
    method: 'POST',
    path: '/v2/ielts/writing/micro-exercises/grade',
    requiredScope: 'writing.exercise',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    family: 'writing',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 20_000,
    maxResponseBytes: WRITING_RESPONSE_MAX_BYTES,
    downstream: 'ai-writing',
    downstreamPath: '/v2/grading-micro-exercise',
    requestSchema: GradeMicroExerciseRequestSchema,
    responseContract: MicroExerciseGradeResponseSchema,
    namedDownstreamErrors: ['INVALID_REQUEST'],
  },
  'speaking.grading': {
    openApi: { summary: 'Grade a Speaking response from an audio upload' },
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/ielts/speaking/grading',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'multipart/form-data',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'model',
    // Wire-body ceiling. Multipart framing rides on top of the audio file,
    // which the AI Speaking provider itself caps at 25 MiB (contract v1
    // section 3); 26 MiB lets a full-size file pass with its framing intact.
    maxBodyBytes: 26 * 1024 * 1024,
    // One deadline covers upload and downstream grading. Uploading 25 MiB on
    // a slow link alone can outlast the old 30s budget before grading starts.
    timeoutMs: 60_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v1/speaking/grading',
    requestSchema: SpeakingGradeRequestSchema,
    responseContract: SpeakingGradeResponseSchema,
    namedDownstreamErrors: ['AUDIO_UNREADABLE'],
  },
  'speaking.grading-json': {
    openApi: { summary: 'Grade a Speaking response from a JSON request' },
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/ielts/speaking/grading-json',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    // URL grading runs the same inference pipeline; leave room for its >30s responses.
    timeoutMs: 60_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v1/speaking/grading-json',
    requestSchema: SpeakingGradeJsonRequestSchema,
    responseContract: SpeakingGradeResponseSchema,
  },
  'speaking.v2.question-grading': {
    openApi: { summary: 'Grade a Speaking question' },
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v2/ielts/speaking/questions/grade',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'multipart/form-data',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'model',
    // The v2 provider allows up to 280 s for grading and recommends a 300 s
    // client timeout. This end-to-end budget also covers the incoming upload.
    maxBodyBytes: 26 * 1024 * 1024,
    timeoutMs: 300_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v2/speaking/questions/grading',
    requestSchema: SpeakingV2QuestionGradeMultipartSchema,
    responseContract: SpeakingV2QuestionResultSchema,
    namedDownstreamErrors: ['AUDIO_UNREADABLE'],
  },
  'speaking.v2.part-grading': {
    openApi: { summary: 'Grade a Speaking part' },
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v2/ielts/speaking/parts/grade',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 120_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v2/speaking/parts/grading',
    requestSchema: SpeakingV2PartGradeRequestSchema,
    responseContract: SpeakingV2PartResultSchema,
  },
  'speaking.v2.test-grading': {
    openApi: { summary: 'Grade a Speaking test' },
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v2/ielts/speaking/tests/grade',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 120_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v2/speaking/tests/grading',
    requestSchema: SpeakingV2TestGradeRequestSchema,
    responseContract: SpeakingV2TestResultSchema,
  },
  'speaking.v2.response-get': {
    openApi: { summary: 'Read a Speaking response result' },
    cacheControl: { value: 'no-store' },
    method: 'GET',
    path: '/v2/ielts/speaking/responses/{response_id}',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'none',
    maxBodyBytes: 0,
    timeoutMs: 30_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v2/speaking/responses/{response_id}',
    pathParamsSchema: SpeakingV2ResponsePathSchema,
    responseContract: SpeakingV2QuestionResultSchema,
  },
  'speaking.v2.part-get': {
    openApi: { summary: 'Read a Speaking part result' },
    cacheControl: { value: 'no-store' },
    method: 'GET',
    path: '/v2/ielts/speaking/parts/{part_result_id}',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'none',
    maxBodyBytes: 0,
    timeoutMs: 30_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v2/speaking/parts/{part_result_id}',
    pathParamsSchema: SpeakingV2PartPathSchema,
    responseContract: SpeakingV2PartResultSchema,
  },
  'speaking.v2.test-get': {
    openApi: { summary: 'Read a Speaking test result' },
    cacheControl: { value: 'no-store' },
    method: 'GET',
    path: '/v2/ielts/speaking/tests/{test_id}',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    idempotency: 'none',
    family: 'speaking',
    meteringMode: 'none',
    maxBodyBytes: 0,
    timeoutMs: 30_000,
    maxResponseBytes: SPEAKING_RESPONSE_MAX_BYTES,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v2/speaking/tests/{test_id}',
    pathParamsSchema: SpeakingV2TestPathSchema,
    responseContract: SpeakingV2TestResultSchema,
  },
} as const satisfies Record<string, OperationDef>;

/**
 * The Scope vocabulary AIHUB publishes. Key creation validates against this so
 * a Scope no operation requires is rejected where the caller can still fix it,
 * rather than becoming a credential that silently grants nothing.
 */
export function publishedScopes(): readonly string[] {
  return [
    ...new Set(
      Object.values(OPERATION_CATALOG).map(
        (operation) => operation.requiredScope,
      ),
    ),
  ];
}

export function publishedEntitlements(): readonly string[] {
  return [
    ...new Set(
      publishedScopes()
        .map((scope) => scope.split('.')[0] ?? '')
        .filter(Boolean),
    ),
  ];
}

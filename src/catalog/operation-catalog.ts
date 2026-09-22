import type { TSchema } from '@sinclair/typebox';

import {
  SpeakingGradeJsonRequestSchema,
  SpeakingGradeRequestSchema,
  SpeakingGradeResponseSchema,
} from '../contracts/speaking/grading';
import {
  GradeResponseSchema,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '../contracts/writing/grading';
import type { DownstreamId } from '../downstream/downstream.types';
import type { OperationId } from './operation-id';

type IdentityScope = 'organization' | 'user';
export type IdempotencyMode = 'none' | 'optional' | 'required';
export type MeteringMode = 'model' | 'none';
type ResponseContract = TSchema | 'unresolved';

export interface OperationDef {
  readonly method: 'POST';
  readonly path: string;
  readonly requiredScope: string;
  readonly identityScope: IdentityScope;
  readonly execution: 'sync';
  readonly contentType: 'application/json' | 'multipart/form-data';
  readonly idempotency: IdempotencyMode;
  readonly meteringMode: MeteringMode;
  readonly maxBodyBytes: number;
  readonly timeoutMs: number;
  readonly downstream: DownstreamId;
  readonly downstreamPath: string;
  readonly requestSchema: TSchema;
  readonly responseContract: ResponseContract;
}

export const OPERATION_CATALOG = {
  'writing.task1.grade': {
    method: 'POST',
    path: '/v1/ielts/writing/task1/grade',
    requiredScope: 'writing.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 60_000,
    downstream: 'ai-writing',
    downstreamPath: '/grading-feedback-task1',
    requestSchema: GradeTask1RequestSchema,
    responseContract: GradeResponseSchema,
  },
  'writing.task2.grade': {
    method: 'POST',
    path: '/v1/ielts/writing/task2/grade',
    requiredScope: 'writing.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'required',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 60_000,
    downstream: 'ai-writing',
    downstreamPath: '/grading-feedback-task2',
    requestSchema: GradeTask2RequestSchema,
    responseContract: GradeResponseSchema,
  },
  'speaking.grading': {
    method: 'POST',
    path: '/v1/ielts/speaking/grading',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'multipart/form-data',
    idempotency: 'none',
    meteringMode: 'model',
    // Wire-body ceiling. Multipart framing rides on top of the audio file,
    // which the AI Speaking provider itself caps at 25 MiB (contract v1
    // section 3); 26 MiB lets a full-size file pass with its framing intact.
    maxBodyBytes: 26 * 1024 * 1024,
    // One deadline covers upload and downstream grading. Uploading 25 MiB on
    // a slow link alone can outlast the old 30s budget before grading starts.
    timeoutMs: 60_000,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v1/speaking/grading',
    requestSchema: SpeakingGradeRequestSchema,
    responseContract: SpeakingGradeResponseSchema,
  },
  'speaking.grading-json': {
    method: 'POST',
    path: '/v1/ielts/speaking/grading-json',
    requiredScope: 'speaking.grade',
    identityScope: 'user',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'none',
    meteringMode: 'model',
    maxBodyBytes: 256 * 1024,
    timeoutMs: 30_000,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v1/speaking/grading-json',
    requestSchema: SpeakingGradeJsonRequestSchema,
    responseContract: SpeakingGradeResponseSchema,
  },
} as const satisfies Record<OperationId, OperationDef>;

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

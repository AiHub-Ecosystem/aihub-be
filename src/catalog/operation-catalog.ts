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

export type IdentityScope = 'organization' | 'user';
export type IdempotencyMode = 'none' | 'optional' | 'required';
export type ResponseContract = TSchema | 'unresolved';

export interface OperationDef {
  readonly method: 'POST';
  readonly path: string;
  readonly requiredScope: string;
  readonly identityScope: IdentityScope;
  readonly execution: 'sync';
  readonly contentType: 'application/json' | 'multipart/form-data';
  readonly idempotency: IdempotencyMode;
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
    maxBodyBytes: 25 * 1024 * 1024,
    timeoutMs: 30_000,
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
    maxBodyBytes: 256 * 1024,
    timeoutMs: 30_000,
    downstream: 'ai-speaking',
    downstreamPath: '/api/v1/speaking/grading-json',
    requestSchema: SpeakingGradeJsonRequestSchema,
    responseContract: SpeakingGradeResponseSchema,
  },
} as const satisfies Record<OperationId, OperationDef>;

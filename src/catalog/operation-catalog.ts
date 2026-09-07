import type { TSchema } from '@sinclair/typebox';

import {
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
  Task1QuestionRequestSchema,
  Task1QuestionResponseSchema,
  Task2QuestionRequestSchema,
  Task2QuestionResponseSchema,
} from '../contracts/writing/grading';
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
  readonly contentType: 'application/json';
  readonly idempotency: IdempotencyMode;
  readonly maxBodyBytes: number;
  readonly timeoutMs: number;
  readonly downstream: 'ai-writing';
  readonly downstreamPath: string;
  readonly requestSchema: TSchema;
  readonly responseContract: ResponseContract;
}

export const OPERATION_CATALOG = {
  'writing.task1.question.generate': {
    method: 'POST',
    path: '/v1/writing/task1/questions',
    requiredScope: 'writing.question.generate',
    identityScope: 'organization',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'none',
    maxBodyBytes: 8 * 1024,
    timeoutMs: 10_000,
    downstream: 'ai-writing',
    downstreamPath: '/generate-question-task1',
    requestSchema: Task1QuestionRequestSchema,
    responseContract: Task1QuestionResponseSchema,
  },
  'writing.task2.question.generate': {
    method: 'POST',
    path: '/v1/writing/task2/questions',
    requiredScope: 'writing.question.generate',
    identityScope: 'organization',
    execution: 'sync',
    contentType: 'application/json',
    idempotency: 'optional',
    maxBodyBytes: 8 * 1024,
    timeoutMs: 30_000,
    downstream: 'ai-writing',
    downstreamPath: '/question-generated-task2',
    requestSchema: Task2QuestionRequestSchema,
    responseContract: Task2QuestionResponseSchema,
  },
  'writing.task1.grade': {
    method: 'POST',
    path: '/v1/writing/task1/grade',
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
    responseContract: 'unresolved',
  },
  'writing.task2.grade': {
    method: 'POST',
    path: '/v1/writing/task2/grade',
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
    responseContract: 'unresolved',
  },
} as const satisfies Record<OperationId, OperationDef>;

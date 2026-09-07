import type { OperationId } from '../../../catalog/operation-id';
import type { RequestContext } from '../../../common/request-context/request-context';
import type {
  GradeResponse,
  GradeTask1Request,
  GradeTask2Request,
} from '../../../contracts/writing/grading';
import type {
  Task1QuestionRequest,
  Task1QuestionResponse,
} from '../../../contracts/writing/task1';
import type {
  Task2QuestionRequest,
  Task2QuestionResponse,
} from '../../../contracts/writing/task2';

export interface DispatchResult<TOutput> {
  readonly operation: OperationId;
  readonly data: TOutput;
  readonly downstreamMs: number;
}

/**
 * One overload per operation rather than a single generic signature: with
 * only four operations, this gives every call site full type safety (the
 * input and result are pinned to the literal operation string) without
 * needing schema-derived mapped types. The implementation's own signature is
 * necessarily broader than any one overload — that is where the type
 * erasure inherent to a dispatch table actually lives, not at any call site.
 */
export interface OperationDispatcherPort {
  dispatch(
    operation: 'writing.task1.question.generate',
    input: Task1QuestionRequest,
    context: RequestContext,
  ): Promise<DispatchResult<Task1QuestionResponse>>;
  dispatch(
    operation: 'writing.task2.question.generate',
    input: Task2QuestionRequest,
    context: RequestContext,
  ): Promise<DispatchResult<Task2QuestionResponse>>;
  dispatch(
    operation: 'writing.task1.grade',
    input: GradeTask1Request,
    context: RequestContext,
  ): Promise<DispatchResult<GradeResponse>>;
  dispatch(
    operation: 'writing.task2.grade',
    input: GradeTask2Request,
    context: RequestContext,
  ): Promise<DispatchResult<GradeResponse>>;
}

export const OPERATION_DISPATCHER = Symbol('OPERATION_DISPATCHER');

import type { OperationId } from '../../../catalog/operation-id';
import type { RequestContext } from '../../../common/request-context/request-context';
import type {
  Task1QuestionRequest,
  Task1QuestionResponse,
} from '../../../contracts/writing/task1';

export interface DispatchResult<TOutput> {
  readonly operation: OperationId;
  readonly data: TOutput;
  readonly downstreamMs: number;
}

export interface OperationDispatcherPort {
  dispatch(
    operation: 'writing.task1.question.generate',
    input: Task1QuestionRequest,
    context: RequestContext,
  ): Promise<DispatchResult<Task1QuestionResponse>>;
}

export const OPERATION_DISPATCHER = Symbol('OPERATION_DISPATCHER');

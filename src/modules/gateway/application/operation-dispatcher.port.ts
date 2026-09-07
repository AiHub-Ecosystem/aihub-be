import type { OperationId } from '../../../catalog/operation-id';
import type { RequestContext } from '../../../common/request-context/request-context';

export interface OperationDispatcherPort {
  dispatch<TInput, TOutput>(
    operation: OperationId,
    input: TInput,
    context: RequestContext,
  ): Promise<TOutput>;
}

export const OPERATION_DISPATCHER = Symbol('OPERATION_DISPATCHER');

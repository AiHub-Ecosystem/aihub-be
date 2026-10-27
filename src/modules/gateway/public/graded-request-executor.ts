import type { OperationId } from '@/catalog/operation-id';
import type {
  DispatchResult,
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/operation-dispatcher.port';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';

/** A parser may return a release function for resources held through grading. */
export interface PreparedGradedInput<TInput> {
  readonly input: TInput;
  readonly release?: () => void;
}

export interface GradedRequestExecutorPort {
  execute<K extends OperationId>(
    request: AuthenticatedRequest,
    operation: K,
    prepareInput: (
      signal: AbortSignal,
    ) =>
      | PreparedGradedInput<RequestFor<K>>
      | Promise<PreparedGradedInput<RequestFor<K>>>,
  ): Promise<DispatchResult<ResponseFor<K>>>;
}

export const GRADED_REQUEST_EXECUTOR = Symbol('GRADED_REQUEST_EXECUTOR');

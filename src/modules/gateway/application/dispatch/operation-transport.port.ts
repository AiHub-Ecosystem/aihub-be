import type { OperationId } from '@/catalog/operation-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  DispatchResult,
  RequestFor,
  ResponseFor,
} from './operation-dispatcher.port';

/** What the dispatch policy hands the transport for the one call it may make. */
export interface TransportCall {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  /** Called with the status code once any response has arrived. */
  readonly onResponseReceived: (statusCode: number) => void;
}

export interface PreparedDispatch<O extends OperationId> {
  /** Makes the one downstream call; maps status, parses, and logs a failure. */
  send(call: TransportCall): Promise<DispatchResult<ResponseFor<O>>>;
}

/**
 * The transport half of a dispatch: selects the operation's adapter, builds
 * the request and its credentials, and performs the HTTP call. It holds no
 * admission, evidence, or deadline decision; `GuardedOperationDispatcher` owns
 * those and calls `prepare` first so a misconfigured operation fails before
 * anything is reserved or recorded.
 */
export interface OperationTransportPort {
  prepare<O extends OperationId>(
    operation: O,
    input: RequestFor<O>,
    context: RequestContext,
  ): Promise<PreparedDispatch<O>>;
  /** True when `error` proves the request never left this process. */
  isUndelivered(error: unknown): boolean;
}

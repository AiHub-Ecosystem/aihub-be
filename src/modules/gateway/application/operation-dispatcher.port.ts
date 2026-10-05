import type { OperationId } from '@/catalog/operation-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type { SpeakingGradeResponse } from '@/contracts/speaking/grading';
import type { GradeResponse } from '@/contracts/writing/grading';
import type {
  MeteringModel,
  MeteringUsage,
} from '@/modules/metering/application/metering-finalizer.port';

export interface DispatchResult<TOutput> {
  readonly operation: OperationId;
  readonly data: TOutput;
  readonly downstreamMs: number;
  readonly usage?: MeteringUsage;
  readonly models?: readonly MeteringModel[];
  readonly aiProcessingMs?: number;
  readonly idempotentReplay?: boolean;
}

/**
 * Per-operation typing is one generic mapped by the operation literal, not
 * one overload per operation: the literal selects the output family, and the
 * input erases to `unknown` — the same erasure the adapter table already
 * makes. Adding an operation never edits this file's shape; any operation id
 * following the `writing.`/`speaking.` prefix convention inherits its output
 * family automatically.
 */
export type DispatchOutputFor<O extends OperationId> =
  O extends `writing.${string}`
    ? GradeResponse
    : O extends `speaking.${string}`
      ? SpeakingGradeResponse
      : unknown;

export interface OperationDispatcherPort {
  dispatch<O extends OperationId>(
    operation: O,
    input: unknown,
    context: RequestContext,
  ): Promise<DispatchResult<DispatchOutputFor<O>>>;
}

export const OPERATION_DISPATCHER = Symbol('OPERATION_DISPATCHER');

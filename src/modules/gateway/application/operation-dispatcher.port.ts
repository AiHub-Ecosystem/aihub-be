import type { OperationId } from '../../../catalog/operation-id';
import type { RequestContext } from '../../../common/request-context/request-context';
import type {
  SpeakingGradeInput,
  SpeakingGradeJsonInput,
  SpeakingGradeResponse,
} from '../../../contracts/speaking/grading';
import type {
  GradeResponse,
  GradeTask1Request,
  GradeTask2Request,
} from '../../../contracts/writing/grading';
import type {
  MeteringModel,
  MeteringUsage,
} from '../../metering/application/metering-finalizer.port';

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
 * One overload per operation rather than a single generic signature: with
 * only four operations, this gives every call site full type safety (the
 * input and result are pinned to the literal operation string) without
 * needing schema-derived mapped types. The implementation's own signature is
 * necessarily broader than any one overload — that is where the type
 * erasure inherent to a dispatch table actually lives, not at any call site.
 */
export interface OperationDispatcherPort {
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
  dispatch(
    operation: 'speaking.grading',
    input: SpeakingGradeInput,
    context: RequestContext,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
  dispatch(
    operation: 'speaking.grading-json',
    input: SpeakingGradeJsonInput,
    context: RequestContext,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
}

export const OPERATION_DISPATCHER = Symbol('OPERATION_DISPATCHER');

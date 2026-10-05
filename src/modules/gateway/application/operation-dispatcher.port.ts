import type { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingGradeInput,
  SpeakingGradeJsonInput,
  SpeakingGradeResponse,
} from '@/contracts/speaking/grading';
import type {
  GradeResponse,
  GradeTask1Request,
  GradeTask2Request,
} from '@/contracts/writing/grading';
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
 * Request/response types per operation. Input types are a roster — one arm
 * per operation — because they are the application's own command inputs, not
 * the wire format of the catalog schemas. The response family is read off
 * the operation's own catalog record (`family`), so a catalog entry fully
 * determines it; an unknown family yields `never`.
 */
export type RequestFor<K extends OperationId> = K extends 'writing.task1.grade'
  ? GradeTask1Request
  : K extends 'writing.task2.grade'
    ? GradeTask2Request
    : K extends 'speaking.grading'
      ? SpeakingGradeInput
      : K extends 'speaking.grading-json'
        ? SpeakingGradeJsonInput
        : never;

export type ResponseFor<K extends OperationId> =
  (typeof OPERATION_CATALOG)[K]['family'] extends 'writing'
    ? GradeResponse
    : SpeakingGradeResponse;

export interface OperationDispatcherPort {
  dispatch<O extends OperationId>(
    operation: O,
    input: RequestFor<O>,
    context: RequestContext,
  ): Promise<DispatchResult<ResponseFor<O>>>;
}

export const OPERATION_DISPATCHER = Symbol('OPERATION_DISPATCHER');

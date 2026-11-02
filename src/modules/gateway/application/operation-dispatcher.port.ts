import type { Static, TSchema } from '@sinclair/typebox';

import type { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingGradeInput,
  SpeakingGradeJsonInput,
  SpeakingGradeResponse,
} from '@/contracts/speaking/grading';
import type {
  SpeakingV2PartGradeInput,
  SpeakingV2QuestionGradeInput,
  SpeakingV2TestGradeInput,
} from '@/contracts/speaking/v2/inputs';
import type {
  GradeResponse,
  GradeTask1Request,
  GradeTask2Request,
} from '@/contracts/writing/grading';
import type {
  CreateLongWritingExerciseRequest,
  CreateMicroExerciseRequest,
  GradeMicroExerciseRequest,
} from '@/contracts/writing/v2/exercises';
import type {
  WritingV2GradeTask1Request,
  WritingV2GradeTask2Request,
} from '@/contracts/writing/v2/grading';
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

/** POST commands keep application-owned input types; GET inputs come from path parameters. */
type CatalogRequest<K extends OperationId> =
  (typeof OPERATION_CATALOG)[K] extends {
    readonly method: 'GET';
    readonly pathParamsSchema: infer T extends TSchema;
  }
    ? Static<T>
    : never;

export type RequestFor<K extends OperationId> = K extends 'writing.task1.grade'
  ? GradeTask1Request
  : K extends 'writing.task2.grade'
    ? GradeTask2Request
    : K extends 'writing.v2.task1.grade'
      ? WritingV2GradeTask1Request
      : K extends 'writing.v2.task2.grade'
        ? WritingV2GradeTask2Request
        : K extends 'writing.v2.micro-exercises.create'
          ? CreateMicroExerciseRequest
          : K extends 'writing.v2.long-writing-exercises.create'
            ? CreateLongWritingExerciseRequest
            : K extends 'writing.v2.micro-exercises.grade'
              ? GradeMicroExerciseRequest
              : K extends 'speaking.grading'
                ? SpeakingGradeInput
                : K extends 'speaking.grading-json'
                  ? SpeakingGradeJsonInput
                  : K extends 'speaking.v2.question-grading'
                    ? SpeakingV2QuestionGradeInput
                    : K extends 'speaking.v2.part-grading'
                      ? SpeakingV2PartGradeInput
                      : K extends 'speaking.v2.test-grading'
                        ? SpeakingV2TestGradeInput
                        : CatalogRequest<K>;

type CatalogResponse<K extends OperationId> =
  (typeof OPERATION_CATALOG)[K]['responseContract'] extends infer T
    ? T extends TSchema
      ? Static<T>
      : never
    : never;

export type ResponseFor<K extends OperationId> = K extends
  | 'writing.task1.grade'
  | 'writing.task2.grade'
  ? GradeResponse
  : K extends 'speaking.grading' | 'speaking.grading-json'
    ? SpeakingGradeResponse
    : CatalogResponse<K>;

export interface OperationDispatcherPort {
  /**
   * Concrete implementation: `GuardedOperationDispatcher` (policy) over
   * `HttpOperationTransport` in `src/modules/gateway/infrastructure/`, wired in
   * `GatewayModule`. The per-operation adapters the transport selects from the
   * composition-root array live in `src/downstream/<service>/`
   * (`writing/`, `speaking/`), as a source boundary, never inside a feature
   * module.
   */
  dispatch<O extends OperationId>(
    operation: O,
    input: RequestFor<O>,
    context: RequestContext,
  ): Promise<DispatchResult<ResponseFor<O>>>;
}

export const OPERATION_DISPATCHER = Symbol('OPERATION_DISPATCHER');

import type { OperationId } from '@/catalog/operation-id';
import type {
  GradeTask1Request,
  GradeTask2Request,
} from '@/contracts/writing/grading';
import type { IdempotencyBackgroundLifecycle } from '@/modules/idempotency/application/idempotency-service.port';
import type { CompletedIdempotencyReplay } from '@/modules/idempotency/public/idempotency-operation';
import {
  type DispatchResult,
  type RequestFor,
  type ResponseFor,
} from './operation-dispatcher.port';

export interface GradingRequestMetadata {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly signal: AbortSignal;
  /** Called only when work crosses the idempotency gate into dispatch. */
  readonly onDispatchStart?: () => void;
  /** Called when the AI Service result is available, before persistence and metering. */
  readonly onAiServiceResultAvailable?: () => void;
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly environment: string;
  readonly userId: string;
  readonly scopes: readonly string[];
}

interface WritingCommand extends GradingRequestMetadata {
  readonly idempotencyKey?: string;
  readonly backgroundLifecycle?: IdempotencyBackgroundLifecycle;
  readonly completedReplay?: CompletedIdempotencyReplay;
}

export interface GradeTask1Command extends WritingCommand {
  readonly operation: 'writing.task1.grade';
  readonly input: GradeTask1Request;
}

export interface GradeTask2Command extends WritingCommand {
  readonly operation: 'writing.task2.grade';
  readonly input: GradeTask2Request;
}

/**
 * The minimal shape every dispatch command satisfies. `OperationId` is the
 * union of the operation keys in the catalog, so adding a catalog entry
 * widens this automatically — no edit here.
 */
export type BaseGradingCommand = GradingRequestMetadata & {
  readonly operation: OperationId;
  readonly input: RequestFor<OperationId>;
};

export type ResponseForCommand<C extends BaseGradingCommand> = ResponseFor<
  C['operation']
>;

/**
 * The grading port both feature modules dispatch through. Declared and bound
 * by the Gateway module: `GradingOrchestrator` (this folder) dispatches via
 * `GuardedOperationDispatcher` over `HttpOperationTransport`, whose per-operation adapters live in
 * `src/downstream/writing/` and `src/downstream/speaking/`. Feature modules
 * deliberately own no adapter of their own — the source-boundary rule in
 * AGENTS.md puts pure adapters in `src/downstream` rather than in a feature
 * module.
 */
export interface GradingOrchestratorPort {
  execute<C extends BaseGradingCommand>(
    command: C,
  ): Promise<DispatchResult<ResponseForCommand<C>>>;
}

export const GRADING_ORCHESTRATOR = Symbol('GRADING_ORCHESTRATOR');

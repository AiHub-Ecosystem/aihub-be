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
import type { IdempotencyBackgroundLifecycle } from '../../idempotency/application/idempotency-service.port';
import type { DispatchResult } from './operation-dispatcher.port';

export interface GradingRequestMetadata {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly signal: AbortSignal;
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly environment: string;
  readonly sandboxOrganizationDispatchLimit?: number | null;
  readonly userId: string;
  readonly scopes: readonly string[];
}

interface WritingCommand extends GradingRequestMetadata {
  readonly idempotencyKey?: string;
  readonly backgroundLifecycle?: IdempotencyBackgroundLifecycle;
}

export interface GradeTask1Command extends WritingCommand {
  readonly operation: 'writing.task1.grade';
  readonly input: GradeTask1Request;
}

export interface GradeTask2Command extends WritingCommand {
  readonly operation: 'writing.task2.grade';
  readonly input: GradeTask2Request;
}

export interface GradeSpeakingCommand extends GradingRequestMetadata {
  readonly operation: 'speaking.grading';
  readonly input: SpeakingGradeInput;
}

export interface GradeSpeakingJsonCommand extends GradingRequestMetadata {
  readonly operation: 'speaking.grading-json';
  readonly input: SpeakingGradeJsonInput;
}

export type GradingCommand =
  | GradeTask1Command
  | GradeTask2Command
  | GradeSpeakingCommand
  | GradeSpeakingJsonCommand;

export interface GradingOrchestratorPort {
  execute(command: GradeTask1Command): Promise<DispatchResult<GradeResponse>>;
  execute(command: GradeTask2Command): Promise<DispatchResult<GradeResponse>>;
  execute(
    command: GradeSpeakingCommand,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
  execute(
    command: GradeSpeakingJsonCommand,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
}

export const GRADING_ORCHESTRATOR = Symbol('GRADING_ORCHESTRATOR');

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { RequestContext } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { SpeakingGradeResponse } from '@/contracts/speaking/grading';
import {
  type GradeResponse,
  decodeGradeResponse,
} from '@/contracts/writing/grading';
import type {
  IdempotencyServicePort,
  IdempotencyWorkContext,
} from '@/modules/idempotency/application/idempotency-service.port';
import {
  readDispatchTelemetry,
  withDispatchTelemetry,
} from './dispatch-telemetry';
import type {
  GradeSpeakingCommand,
  GradeSpeakingJsonCommand,
  GradeTask1Command,
  GradeTask2Command,
  GradingCommand,
  GradingOrchestratorPort,
} from './grading-orchestrator.port';
import type {
  DispatchResult,
  OperationDispatcherPort,
} from './operation-dispatcher.port';

type WritingCommand = GradeTask1Command | GradeTask2Command;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeWritingReplay(
  value: unknown,
  operation: WritingCommand['operation'],
): DispatchResult<GradeResponse> {
  if (
    !isRecord(value) ||
    value.operation !== operation ||
    typeof value.downstreamMs !== 'number' ||
    !Number.isFinite(value.downstreamMs) ||
    value.downstreamMs < 0 ||
    !('data' in value)
  ) {
    throw new Error(`stored ${operation} grading response is malformed`);
  }

  return withDispatchTelemetry(
    {
      operation,
      data: decodeGradeResponse(value.data),
      downstreamMs: value.downstreamMs,
    },
    readDispatchTelemetry(value),
  );
}

export class GradingOrchestrator implements GradingOrchestratorPort {
  constructor(
    private readonly dispatcher: OperationDispatcherPort,
    private readonly idempotency: IdempotencyServicePort,
  ) {}

  execute(command: GradeTask1Command): Promise<DispatchResult<GradeResponse>>;
  execute(command: GradeTask2Command): Promise<DispatchResult<GradeResponse>>;
  execute(
    command: GradeSpeakingCommand,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
  execute(
    command: GradeSpeakingJsonCommand,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
  execute(
    command: GradingCommand,
  ): Promise<DispatchResult<GradeResponse | SpeakingGradeResponse>> {
    const context = createRequestContext({
      requestId: command.requestId,
      receivedAt: command.receivedAt,
      deadlineMs: OPERATION_CATALOG[command.operation].timeoutMs,
      organizationId: command.organizationId,
      apiKeyId: command.apiKeyId,
      environment: command.environment,
      ...(command.sandboxOrganizationDispatchLimit === undefined
        ? {}
        : {
            sandboxOrganizationDispatchLimit:
              command.sandboxOrganizationDispatchLimit,
          }),
      userId: command.userId,
      scopes: command.scopes,
      signal: command.signal,
    });

    switch (command.operation) {
      case 'writing.task1.grade':
        return this.executeWriting(command, context, (work) =>
          this.dispatcher.dispatch(command.operation, command.input, {
            ...context,
            signal: work.signal,
            deadlineAt: work.deadlineAt,
          }),
        );
      case 'writing.task2.grade':
        return this.executeWriting(command, context, (work) =>
          this.dispatcher.dispatch(command.operation, command.input, {
            ...context,
            signal: work.signal,
            deadlineAt: work.deadlineAt,
          }),
        );
      case 'speaking.grading':
        return this.dispatcher.dispatch(
          command.operation,
          command.input,
          context,
        );
      case 'speaking.grading-json':
        return this.dispatcher.dispatch(
          command.operation,
          command.input,
          context,
        );
    }
  }

  private async executeWriting(
    command: WritingCommand,
    context: RequestContext,
    work: (
      context: IdempotencyWorkContext,
    ) => Promise<DispatchResult<GradeResponse>>,
  ): Promise<DispatchResult<GradeResponse>> {
    const execution = await this.idempotency.execute(
      {
        organizationId: command.organizationId,
        operation: command.operation,
        ...(command.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: command.idempotencyKey }),
        actorId: command.userId,
        requestBody: command.input,
        requestId: command.requestId,
        timeoutMs: OPERATION_CATALOG[command.operation].timeoutMs,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        ...(command.backgroundLifecycle === undefined
          ? {}
          : { backgroundLifecycle: command.backgroundLifecycle }),
      },
      work,
      (value) => decodeWritingReplay(value, command.operation),
    );

    return execution.replay
      ? { ...execution.result, downstreamMs: 0, idempotentReplay: true }
      : execution.result;
  }
}

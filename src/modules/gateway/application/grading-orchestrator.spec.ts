import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type { SpeakingGradeResponse } from '@/contracts/speaking/grading';
import type { GradeResponse } from '@/contracts/writing/grading';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '@/modules/idempotency/application/idempotency-service.port';
import { GradingOrchestrator } from './grading-orchestrator';
import type {
  GradingOrchestratorPort,
  GradingRequestMetadata,
} from './grading-orchestrator.port';
import type { OperationDispatcherPort } from './operation-dispatcher.port';

const writingData: GradeResponse = {
  overall_band: 7,
  language: 'vi',
  criteria: [
    {
      id: 'task_achievement',
      name: 'Task achievement',
      band: 7,
      band_reason: '',
      strengths: [],
      improvements: [],
    },
    {
      id: 'coherence_cohesion',
      name: 'Coherence',
      band: 7,
      band_reason: '',
      strengths: [],
      improvements: [],
    },
    {
      id: 'lexical_resource',
      name: 'Vocabulary',
      band: 7,
      band_reason: '',
      strengths: [],
      improvements: [],
    },
    {
      id: 'grammatical_range_accuracy',
      name: 'Grammar',
      band: 7,
      band_reason: '',
      strengths: [],
      improvements: [],
    },
  ],
  summary: '',
  suggestions: [],
  next_steps: [],
  annotations: [],
};

const speakingData = {} as SpeakingGradeResponse;
const receivedAt = new Date('2026-09-27T04:00:00.000Z');

function metadata(signal: AbortSignal): GradingRequestMetadata {
  return {
    requestId: 'req-183',
    receivedAt,
    signal,
    organizationId: 'org-183',
    apiKeyId: 'key-183',
    environment: 'production',
    userId: 'user-183',
    scopes: ['writing.grade', 'speaking.grade'],
  };
}

function fixture() {
  const calls: Array<{
    operation: OperationId;
    input: unknown;
    context: RequestContext;
    abortedAtDispatch: boolean;
  }> = [];
  const executions: IdempotencyExecutionInput[] = [];
  const stored = new Map<string, unknown>();
  const workSignal = new AbortController().signal;
  const workDeadline = new Date('2026-09-27T04:02:00.000Z');
  const dispatcher = {
    dispatch: async (
      operation: OperationId,
      input: unknown,
      context: RequestContext,
    ) => {
      calls.push({
        operation,
        input,
        context,
        abortedAtDispatch: context.signal.aborted,
      });
      return {
        operation,
        data: operation.startsWith('writing.') ? writingData : speakingData,
        downstreamMs: 23,
      };
    },
  } as OperationDispatcherPort;
  const idempotency: IdempotencyServicePort = {
    async execute<T>(
      input: IdempotencyExecutionInput,
      work: IdempotencyWork<T>,
      decodeReplay: IdempotencyReplayDecoder<T>,
    ): Promise<IdempotencyExecution<T>> {
      executions.push(input);
      const key = `${input.operation}:${input.idempotencyKey}`;
      if (stored.has(key)) {
        return { result: decodeReplay(stored.get(key)), replay: true };
      }
      const result = await work({
        signal: workSignal,
        deadlineAt: workDeadline,
      });
      stored.set(key, result);
      return { result, replay: false };
    },
  };
  const port: GradingOrchestratorPort = new GradingOrchestrator(
    dispatcher,
    idempotency,
  );
  return { port, calls, executions, stored, workSignal, workDeadline };
}

describe('GradingOrchestratorPort', () => {
  it('uses the ingress deadline and detached Writing work context for both tasks and their replays', async () => {
    const { port, calls, executions, workSignal, workDeadline } = fixture();
    const lifecycle = new AbortController();
    lifecycle.abort();
    const backgroundLifecycle = {
      started: jest.fn(),
      settled: jest.fn(),
    };
    const common = { ...metadata(lifecycle.signal), backgroundLifecycle };
    const task1 = {
      ...common,
      operation: 'writing.task1.grade' as const,
      input: {
        question: 'Describe the chart.',
        chart_type: 'Bar Chart' as const,
        essay: 'A clear essay.',
        image_url: 'https://example.com/chart.png',
      },
      idempotencyKey: 'task1-key',
    };
    const task2 = {
      ...common,
      operation: 'writing.task2.grade' as const,
      input: {
        question: 'Discuss the topic.',
        topic: 'education',
        essay: 'A clear essay.',
      },
      idempotencyKey: 'task2-key',
    };

    const firstTask1 = await port.execute(task1);
    const firstTask2 = await port.execute(task2);
    const replayTask1 = await port.execute(task1);
    const replayTask2 = await port.execute(task2);

    expect(firstTask1).toMatchObject({
      operation: 'writing.task1.grade',
      data: writingData,
    });
    expect(firstTask2).toMatchObject({
      operation: 'writing.task2.grade',
      data: writingData,
    });
    expect(calls).toHaveLength(2);
    const task1Call = calls.find(
      (call) => call.operation === 'writing.task1.grade',
    );
    const task2Call = calls.find(
      (call) => call.operation === 'writing.task2.grade',
    );
    expect(task1Call?.input).toBe(task1.input);
    expect(task2Call?.input).toBe(task2.input);
    expect(task1Call?.context).toMatchObject({
      organizationId: 'org-183',
      apiKeyId: 'key-183',
      userId: 'user-183',
      receivedAt,
      deadlineAt: workDeadline,
      signal: workSignal,
    });
    expect(task2Call?.context).toMatchObject({
      organizationId: 'org-183',
      apiKeyId: 'key-183',
      userId: 'user-183',
      receivedAt,
      deadlineAt: workDeadline,
      signal: workSignal,
    });
    expect(executions).toHaveLength(4);
    expect(
      executions.find(
        (execution) => execution.operation === 'writing.task1.grade',
      ),
    ).toMatchObject({
      requestId: 'req-183',
      requestBody: task1.input,
      organizationId: 'org-183',
      actorId: 'user-183',
      idempotencyKey: 'task1-key',
      signal: lifecycle.signal,
      deadlineAt: new Date(
        receivedAt.getTime() +
          OPERATION_CATALOG['writing.task1.grade'].timeoutMs,
      ),
      backgroundLifecycle,
    });
    expect(
      executions.find(
        (execution) => execution.operation === 'writing.task2.grade',
      ),
    ).toMatchObject({
      requestBody: task2.input,
      idempotencyKey: 'task2-key',
      signal: lifecycle.signal,
      deadlineAt: new Date(
        receivedAt.getTime() +
          OPERATION_CATALOG['writing.task2.grade'].timeoutMs,
      ),
      backgroundLifecycle,
    });
    expect(task1Call?.abortedAtDispatch).toBe(false);
    expect(task2Call?.abortedAtDispatch).toBe(false);
    expect(replayTask1).toMatchObject({
      operation: 'writing.task1.grade',
      data: writingData,
      downstreamMs: 0,
      idempotentReplay: true,
    });
    expect(replayTask2).toMatchObject({
      operation: 'writing.task2.grade',
      data: writingData,
      downstreamMs: 0,
      idempotentReplay: true,
    });
  });

  it('decodes replay telemetry and rejects malformed Writing data without another dispatch', async () => {
    const { port, calls, stored } = fixture();
    const command = {
      ...metadata(new AbortController().signal),
      operation: 'writing.task2.grade' as const,
      input: {
        question: 'Discuss the topic.',
        topic: 'education',
        essay: 'A clear essay.',
      },
      idempotencyKey: 'replay-key',
    };
    const first = await port.execute(command);
    const key = 'writing.task2.grade:replay-key';
    stored.set(key, { ...first, aiProcessingMs: 17 });

    await expect(port.execute(command)).resolves.toMatchObject({
      data: writingData,
      downstreamMs: 0,
      aiProcessingMs: 17,
      idempotentReplay: true,
    });
    stored.set(key, {
      ...first,
      data: { ...writingData, overall_band: 10 },
    });
    await expect(port.execute(command)).rejects.toThrow(
      'stored Writing grading response is malformed',
    );
    expect(calls).toHaveLength(1);
  });

  it('dispatches both Speaking operations directly with the lifecycle signal and individual deadlines', async () => {
    const { port, calls, executions } = fixture();
    const lifecycle = new AbortController();
    const common = metadata(lifecycle.signal);
    const multipartInput = {
      audio: {
        bytes: Buffer.from('audio'),
        filename: 'answer.wav',
        contentType: 'audio/wav',
      },
      part: 1 as const,
      questionId: 'p1_hometown',
    };
    const jsonInput = {
      audioUrl: 'https://example.com/answer.wav',
      part: 1 as const,
      questionId: 'p1_hometown',
      testType: 'Practice',
    };

    const multipart = await port.execute({
      ...common,
      operation: 'speaking.grading',
      input: multipartInput,
    });
    lifecycle.abort();
    const json = await port.execute({
      ...common,
      operation: 'speaking.grading-json',
      input: jsonInput,
    });

    expect(multipart).toMatchObject({
      operation: 'speaking.grading',
      data: speakingData,
    });
    expect(json).toMatchObject({
      operation: 'speaking.grading-json',
      data: speakingData,
    });
    expect(executions).toHaveLength(0);
    expect(calls).toHaveLength(2);
    const multipartCall = calls.find(
      (call) => call.operation === 'speaking.grading',
    );
    const jsonCall = calls.find(
      (call) => call.operation === 'speaking.grading-json',
    );
    expect(multipartCall?.input).toBe(multipartInput);
    expect(jsonCall?.input).toBe(jsonInput);
    expect(multipartCall?.abortedAtDispatch).toBe(false);
    expect(jsonCall?.abortedAtDispatch).toBe(true);
    for (const call of calls) {
      expect(call.context).toMatchObject({
        organizationId: 'org-183',
        userId: 'user-183',
        receivedAt,
        deadlineAt: new Date(
          receivedAt.getTime() + OPERATION_CATALOG[call.operation].timeoutMs,
        ),
        signal: lifecycle.signal,
      });
      expect(call.context.signal).toBe(lifecycle.signal);
    }
  });
});

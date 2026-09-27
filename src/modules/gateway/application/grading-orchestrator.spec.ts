import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import type { OperationId } from '../../../catalog/operation-id';
import type { RequestContext } from '../../../common/request-context/request-context';
import type { SpeakingGradeResponse } from '../../../contracts/speaking/grading';
import type { GradeResponse } from '../../../contracts/writing/grading';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '../../idempotency/application/idempotency-service.port';
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
  return { port, calls, executions, workSignal, workDeadline };
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

    expect(firstTask1.data).toEqual(writingData);
    expect(firstTask2.data).toEqual(writingData);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.operation)).toEqual([
      'writing.task1.grade',
      'writing.task2.grade',
    ]);
    expect(calls[0]?.input).toBe(task1.input);
    expect(calls[1]?.input).toBe(task2.input);
    expect(calls[0]?.context).toMatchObject({
      organizationId: 'org-183',
      apiKeyId: 'key-183',
      userId: 'user-183',
      receivedAt,
      deadlineAt: workDeadline,
      signal: workSignal,
    });
    expect(executions).toHaveLength(4);
    expect(executions[0]).toMatchObject({
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
    expect(calls[0]?.abortedAtDispatch).toBe(false);
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

    expect(multipart.data).toBe(speakingData);
    expect(json.data).toBe(speakingData);
    expect(executions).toHaveLength(0);
    expect(calls.map((call) => call.operation)).toEqual([
      'speaking.grading',
      'speaking.grading-json',
    ]);
    expect(calls[0]?.input).toBe(multipartInput);
    expect(calls[1]?.input).toBe(jsonInput);
    expect(calls.map((call) => call.abortedAtDispatch)).toEqual([false, true]);
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

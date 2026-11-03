import type { OperationId } from '@/catalog/operation-id';
import type {
  GradedPipelineContext,
  GradedPipelineEnginePort,
} from '@/modules/gateway/public/graded-pipeline';
import * as pipelineContext from '@/modules/gateway/public/graded-pipeline';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { WritingExerciseController } from './writing-exercise.controller';

function controllerWithDispatch() {
  const calls: { operation: string; input: unknown }[] = [];
  const execute = async <K extends OperationId>(
    context: GradedPipelineContext<K>,
  ) => {
    const { input } = await context.prepareInput(new AbortController().signal);
    calls.push({ operation: context.operation, input });
    return {
      operation: context.operation,
      data: {} as never,
      downstreamMs: 1,
    };
  };
  const engine = { execute } as unknown as GradedPipelineEnginePort;
  return { controller: new WritingExerciseController(engine), calls };
}

const request = {} as AuthenticatedRequest;
const reply = { header: jest.fn() } as never;

beforeEach(() => {
  jest
    .spyOn(pipelineContext, 'createGradedPipelineContext')
    .mockImplementation(((_request, _reply, operation, prepareInput) => ({
      operation,
      prepareInput,
    })) as typeof pipelineContext.createGradedPipelineContext);
});

afterEach(() => jest.restoreAllMocks());

describe('WritingExerciseController', () => {
  it('validates and dispatches micro exercise creation', async () => {
    const { controller, calls } = controllerWithDispatch();
    const body = {
      topic: 'education',
      writing_task: 2,
      criterion: 'grammatical_range_accuracy',
      error_code: 'GRA01',
      prompt: 'Use the target form.',
      question_type: 'grammar',
      comments: [{ quote: 'She go.', explanation: 'Use agreement.' }],
    };

    await controller.createMicro(request, body, reply);

    expect(calls).toEqual([
      {
        operation: 'writing.v2.micro-exercises.create',
        input: body,
      },
    ]);
  });

  it('rejects a criterion that does not apply to the selected task', async () => {
    const { controller, calls } = controllerWithDispatch();

    await expect(
      controller.createMicro(
        request,
        {
          topic: 'education',
          writing_task: 2,
          criterion: 'task_achievement',
          error_code: 'TA01',
          prompt: 'Use the target form.',
          question_type: 'grammar',
          comments: [{ quote: 'She go.', explanation: 'Use agreement.' }],
        },
        reply,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toEqual([]);
  });

  it('validates long-writing errors and keeps user answers behind the grade operation', async () => {
    const { controller, calls } = controllerWithDispatch();

    await controller.createLongWriting(
      request,
      {
        topic: 'education',
        writing_task: 2,
        errors: [
          {
            criterion: 'grammatical_range_accuracy',
            error_code: 'GRA01',
            prompt: 'Use the target form.',
            question_type: 'grammar',
            comments: [{ quote: 'She go.', explanation: 'Use agreement.' }],
          },
          {
            criterion: 'coherence_cohesion',
            error_code: 'CC01',
            prompt: 'Connect the ideas.',
            question_type: 'cohesion',
            comments: [{ quote: 'Also,', explanation: 'Link the clauses.' }],
          },
        ],
      },
      reply,
    );
    await controller.gradeMicro(
      request,
      {
        exercise_type: 'short_writing',
        instruction: 'Write one sentence.',
        question_no: 1,
        question_text: 'Use a conjunction.',
        question_image: null,
        hint: [],
        sample_answer: 'I stayed home because it rained.',
        ai_grading_rubric: 'Uses a correct conjunction.',
        user_answer: 'I stayed home because it rained.',
      },
      reply,
    );

    expect(calls.map(({ operation }) => operation)).toEqual([
      'writing.v2.long-writing-exercises.create',
      'writing.v2.micro-exercises.grade',
    ]);
  });

  it('rejects a private question image before grading', async () => {
    const { controller, calls } = controllerWithDispatch();

    await expect(
      controller.gradeMicro(
        request,
        {
          exercise_type: 'short_writing',
          instruction: 'Write one sentence.',
          question_no: 1,
          question_text: 'Use a conjunction.',
          question_image: 'https://127.0.0.1/chart.png',
          hint: [],
          sample_answer: 'I stayed home because it rained.',
          ai_grading_rubric: 'Uses a correct conjunction.',
          user_answer: 'I stayed home because it rained.',
        },
        reply,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toEqual([]);
  });
});

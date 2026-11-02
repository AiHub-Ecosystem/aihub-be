import type { OperationId } from '@/catalog/operation-id';
import type { GradedRequestExecutorPort } from '@/modules/gateway/public/graded-request-executor';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { WritingExerciseController } from './writing-exercise.controller';

type Prepare = (
  signal: AbortSignal,
) => { readonly input: unknown } | Promise<{ readonly input: unknown }>;

function controllerWithDispatch() {
  const calls: { operation: string; input: unknown }[] = [];
  const execute = async (
    _request: AuthenticatedRequest,
    operation: string,
    prepare: Prepare,
  ) => {
    const { input } = await prepare(new AbortController().signal);
    calls.push({ operation, input });
    return {
      operation: operation as OperationId,
      data: {} as never,
      downstreamMs: 1,
    };
  };
  const executor = { execute } as unknown as GradedRequestExecutorPort;
  return { controller: new WritingExerciseController(executor), calls };
}

const request = {} as AuthenticatedRequest;

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

    await controller.createMicro(request, body);

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
      controller.createMicro(request, {
        topic: 'education',
        writing_task: 2,
        criterion: 'task_achievement',
        error_code: 'TA01',
        prompt: 'Use the target form.',
        question_type: 'grammar',
        comments: [{ quote: 'She go.', explanation: 'Use agreement.' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toEqual([]);
  });

  it('validates long-writing errors and keeps user answers behind the grade operation', async () => {
    const { controller, calls } = controllerWithDispatch();

    await controller.createLongWriting(request, {
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
    });
    await controller.gradeMicro(request, {
      exercise_type: 'short_writing',
      instruction: 'Write one sentence.',
      question_no: 1,
      question_text: 'Use a conjunction.',
      question_image: null,
      hint: [],
      sample_answer: 'I stayed home because it rained.',
      ai_grading_rubric: 'Uses a correct conjunction.',
      user_answer: 'I stayed home because it rained.',
    });

    expect(calls.map(({ operation }) => operation)).toEqual([
      'writing.v2.long-writing-exercises.create',
      'writing.v2.micro-exercises.grade',
    ]);
  });

  it('rejects a private question image before grading', async () => {
    const { controller, calls } = controllerWithDispatch();

    await expect(
      controller.gradeMicro(request, {
        exercise_type: 'short_writing',
        instruction: 'Write one sentence.',
        question_no: 1,
        question_text: 'Use a conjunction.',
        question_image: 'https://127.0.0.1/chart.png',
        hint: [],
        sample_answer: 'I stayed home because it rained.',
        ai_grading_rubric: 'Uses a correct conjunction.',
        user_answer: 'I stayed home because it rained.',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toEqual([]);
  });
});

import {
  isValidWritingExerciseError,
  isValidWritingExerciseImage,
} from './writing-exercise-request.policy';

const error = {
  criterion: 'grammatical_range_accuracy' as const,
  error_code: 'GRA01',
  prompt: 'Use the target form.',
  question_type: 'grammar',
  comments: [{ quote: 'She go.', explanation: 'Use third-person agreement.' }],
};

describe('Writing exercise request policy', () => {
  it.each([
    [1, 'task_achievement', 'TA06', true],
    [1, 'task_response', 'TR01', false],
    [2, 'task_response', 'TR08', true],
    [2, 'task_achievement', 'TA01', false],
    [2, 'coherence_cohesion', 'CC08', true],
    [2, 'lexical_resource', 'LR07', true],
    [2, 'grammatical_range_accuracy', 'GRA19', true],
    [2, 'grammatical_range_accuracy', 'GRA20', true],
    [2, 'grammatical_range_accuracy', 'CC01', true],
    [2, 'grammatical_range_accuracy', 'provider-added-code', true],
  ] as const)(
    'checks the criterion against the task and treats the error code as opaque %s/%s/%s',
    (task, criterion, errorCode, expected) => {
      const input = { ...error, criterion, error_code: errorCode };

      expect(isValidWritingExerciseError(task, input)).toBe(expected);
    },
  );

  it('allows a public chart image only for Task 1', () => {
    const withImage = { ...error, image_url: 'https://cdn.example/chart.png' };

    expect(isValidWritingExerciseError(1, withImage)).toBe(true);
    expect(isValidWritingExerciseError(2, withImage)).toBe(false);
    expect(isValidWritingExerciseError(2, error)).toBe(true);
  });

  it('rejects private image destinations for exercise requests and grading', () => {
    const privateImage = {
      ...error,
      image_url: 'https://127.0.0.1/chart.png',
    };

    expect(isValidWritingExerciseError(1, privateImage)).toBe(false);
    expect(isValidWritingExerciseImage('https://127.0.0.1/chart.png')).toBe(
      false,
    );
    expect(isValidWritingExerciseImage(null)).toBe(true);
  });

  it('uses the exercise URL limit without widening the grading URL policy', () => {
    const imageUrl = `https://cdn.example/${'a'.repeat(2_048 - 20)}`;
    const oversizedImageUrl = `https://cdn.example/${'a'.repeat(2_049 - 20)}`;

    expect(
      isValidWritingExerciseError(1, { ...error, image_url: imageUrl }),
    ).toBe(true);
    expect(isValidWritingExerciseImage(imageUrl)).toBe(true);
    expect(
      isValidWritingExerciseError(1, {
        ...error,
        image_url: oversizedImageUrl,
      }),
    ).toBe(false);
    expect(isValidWritingExerciseImage(oversizedImageUrl)).toBe(false);
  });
});

import type { CriterionId } from '@/contracts/writing/grading';
import {
  WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH,
  type WritingExerciseError,
} from '@/contracts/writing/v2/exercises';
import { isAllowedTask1ImageUrl } from './task1-image-url.policy';

function isCriterionAllowedForTask(
  writingTask: 1 | 2,
  criterion: CriterionId,
): boolean {
  return writingTask === 1
    ? criterion !== 'task_response'
    : criterion !== 'task_achievement';
}

export function isValidWritingExerciseError(
  writingTask: 1 | 2,
  input: Pick<WritingExerciseError, 'criterion' | 'error_code' | 'image_url'>,
): boolean {
  return (
    isCriterionAllowedForTask(writingTask, input.criterion) &&
    (input.image_url == null ||
      (writingTask === 1 &&
        isAllowedTask1ImageUrl(
          input.image_url,
          WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH,
        )))
  );
}

export function isValidWritingExerciseImage(imageUrl: string | null): boolean {
  return (
    imageUrl === null ||
    isAllowedTask1ImageUrl(imageUrl, WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH)
  );
}

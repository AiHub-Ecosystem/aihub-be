import type { RequestContext } from '../../../common/request-context/request-context';
import type {
  GradeTask1Request,
  GradeTask2Request,
} from '../../../contracts/writing/grading';

export type WritingGradeOperation =
  | 'writing.task1.grade'
  | 'writing.task2.grade';

export interface WritingGradeCommand {
  readonly operation: WritingGradeOperation;
  readonly input: GradeTask1Request | GradeTask2Request;
  readonly context: RequestContext;
}

export interface WritingGraderPort {
  grade(command: WritingGradeCommand): Promise<unknown>;
}

export const WRITING_GRADER = Symbol('WRITING_GRADER');

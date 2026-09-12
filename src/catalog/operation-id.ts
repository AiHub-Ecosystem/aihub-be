export const OPERATION_IDS = [
  'writing.task1.question.generate',
  'writing.task2.question.generate',
  'writing.task1.grade',
  'writing.task2.grade',
  'speaking.grading',
] as const;

export type OperationId = (typeof OPERATION_IDS)[number];

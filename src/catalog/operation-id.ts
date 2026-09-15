export const OPERATION_IDS = [
  'writing.task1.grade',
  'writing.task2.grade',
  'speaking.grading',
  'speaking.grading-json',
] as const;

export type OperationId = (typeof OPERATION_IDS)[number];

export function isOperationId(value: string): value is OperationId {
  return (OPERATION_IDS as readonly string[]).includes(value);
}

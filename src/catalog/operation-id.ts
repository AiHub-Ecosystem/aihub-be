import { OPERATION_CATALOG } from './operation-catalog';

export const OPERATION_IDS = Object.keys(OPERATION_CATALOG) as OperationId[];

export type OperationId = keyof typeof OPERATION_CATALOG;

export function isOperationId(value: string): value is OperationId {
  return (OPERATION_IDS as readonly string[]).includes(value);
}

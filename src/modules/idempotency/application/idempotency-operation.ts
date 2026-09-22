import {
  type IdempotencyMode,
  OPERATION_CATALOG,
} from '../../../catalog/operation-catalog';
import { type OperationId, isOperationId } from '../../../catalog/operation-id';

export const ORGANIZATION_INVITATION_CREATE_OPERATION =
  'organizations.invitations.create' as const;

export type IdempotencyOperation =
  | OperationId
  | typeof ORGANIZATION_INVITATION_CREATE_OPERATION;

export function idempotencyMode(
  operation: IdempotencyOperation,
): IdempotencyMode {
  if (isOperationId(operation)) {
    return OPERATION_CATALOG[operation].idempotency;
  }

  if (operation === ORGANIZATION_INVITATION_CREATE_OPERATION) {
    return 'optional';
  }

  throw new Error(`Unknown idempotency operation: ${operation}`);
}

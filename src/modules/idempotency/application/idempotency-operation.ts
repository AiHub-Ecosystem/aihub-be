import {
  type IdempotencyMode,
  OPERATION_CATALOG,
  type OperationDef,
} from '@/catalog/operation-catalog';
import { type OperationId, isOperationId } from '@/catalog/operation-id';
import { internalError } from '@/common/errors/app-error';

export const ORGANIZATION_INVITATION_CREATE_OPERATION =
  'organizations.invitations.create' as const;

export const ORGANIZATION_CREATE_OPERATION = 'organizations.create' as const;

export const SPEAKING_GRADING_JOB_CREATE_OPERATION =
  'speaking.grading-jobs.create' as const;

export type IdempotencyOperation =
  | OperationId
  | typeof ORGANIZATION_INVITATION_CREATE_OPERATION
  | typeof ORGANIZATION_CREATE_OPERATION
  | typeof SPEAKING_GRADING_JOB_CREATE_OPERATION;

export function idempotencyMode(
  operation: string,
  catalog: Readonly<
    Record<string, Pick<OperationDef, 'idempotency'>>
  > = OPERATION_CATALOG,
): IdempotencyMode {
  const injected = catalog[operation];
  if (injected !== undefined) return injected.idempotency;

  if (isOperationId(operation)) {
    return (
      catalog[operation]?.idempotency ??
      OPERATION_CATALOG[operation].idempotency
    );
  }

  if (
    operation === ORGANIZATION_INVITATION_CREATE_OPERATION ||
    operation === ORGANIZATION_CREATE_OPERATION ||
    operation === SPEAKING_GRADING_JOB_CREATE_OPERATION
  ) {
    return 'optional';
  }

  throw internalError('Unknown idempotency operation');
}

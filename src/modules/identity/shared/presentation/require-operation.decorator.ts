import { SetMetadata, applyDecorators } from '@nestjs/common';

import type { OperationId } from '@/catalog/operation-id';

export const REQUIRED_OPERATION_METADATA = 'aihub:required-operation';
export const ADDITIONAL_OPERATION_SCOPES_METADATA =
  'aihub:additional-operation-scopes';

export function RequireOperation(
  operation: OperationId,
  ...additionalScopes: readonly string[]
): MethodDecorator {
  return applyDecorators(
    SetMetadata(REQUIRED_OPERATION_METADATA, operation),
    ...(additionalScopes.length === 0
      ? []
      : [SetMetadata(ADDITIONAL_OPERATION_SCOPES_METADATA, additionalScopes)]),
  );
}

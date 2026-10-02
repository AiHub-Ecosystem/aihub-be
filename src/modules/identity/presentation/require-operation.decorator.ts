import { SetMetadata } from '@nestjs/common';

import type { OperationId } from '@/catalog/operation-id';

export const REQUIRED_OPERATION_METADATA = 'aihub:required-operation';

export function RequireOperation(operation: OperationId): MethodDecorator {
  return SetMetadata(REQUIRED_OPERATION_METADATA, operation);
}

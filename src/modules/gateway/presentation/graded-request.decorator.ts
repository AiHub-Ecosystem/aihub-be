import { UseGuards, UseInterceptors } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { ApiKeyGuard } from '@/modules/identity/api-keys/presentation/api-key.guard';
import { UserIdentityGuard } from '@/modules/identity/shared/presentation/user-identity.guard';
import { SuccessEnvelopeInterceptor } from './success-envelope.interceptor';

/**
 * The operations that run the graded-request chain. Declared separately from
 * the Operation Catalog on purpose: "every public operation" and "every
 * operation that runs the graded chain" are different sets that happen to
 * coincide today, and deriving one from the other would be wrong the moment a
 * non-graded operation is added. The satisfies clause ties each id to a real
 * catalog operation at compile time without making the catalog the source of
 * this list.
 */
export const GRADED_REQUEST_OPERATIONS = [
  'writing.task1.grade',
  'writing.task2.grade',
  'writing.v2.task1.grade',
  'writing.v2.task2.grade',
  'writing.v2.micro-exercises.create',
  'writing.v2.long-writing-exercises.create',
  'writing.v2.micro-exercises.grade',
  'speaking.grading',
  'speaking.grading-json',
  'speaking.v2.question-grading',
  'speaking.v2.part-grading',
  'speaking.v2.test-grading',
  'speaking.v2.response-get',
  'speaking.v2.part-get',
  'speaking.v2.test-get',
] as const satisfies readonly (keyof typeof OPERATION_CATALOG)[];

/**
 * Authentication stays in the Nest chain. The pipeline engine handles the
 * ordered admission and concurrency steps from the controller's explicit input.
 */
export const GRADED_REQUEST_GUARDS = [ApiKeyGuard, UserIdentityGuard] as const;

/**
 * The response side of the same chain. SuccessEnvelopeInterceptor shapes
 * the public response.
 */
export const GRADED_REQUEST_INTERCEPTORS = [
  SuccessEnvelopeInterceptor,
] as const;

/**
 * Applies the whole graded-request chain to a controller. Because the decorator
 * applies the entire declared list, a graded route cannot subscript into or
 * rearrange the order the way it could with a bare exported array.
 */
export function GradedRequest(): ClassDecorator {
  return (target) => {
    UseGuards(...GRADED_REQUEST_GUARDS)(target);
    UseInterceptors(...GRADED_REQUEST_INTERCEPTORS)(target);
  };
}

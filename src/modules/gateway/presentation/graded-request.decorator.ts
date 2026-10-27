import { UseGuards, UseInterceptors } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { ApiKeyGuard } from '@/modules/identity/api-keys/presentation/api-key.guard';
import { UserIdentityGuard } from '@/modules/identity/shared/presentation/user-identity.guard';
import { SuccessEnvelopeInterceptor } from '@/modules/metering/presentation/success-envelope.interceptor';
import { ConcurrencyPermitInterceptor } from './concurrency-permit.interceptor';
import { GradedAdmissionGuard } from './graded-admission.guard';

/**
 * The operations that run the graded-request chain. Declared separately from
 * the Operation Catalog on purpose: "every public operation" and "every
 * operation that runs the graded chain" are different sets that happen to
 * coincide today, and deriving one from the other would be wrong the moment a
 * non-graded operation is added. The `satisfies` clause ties each id to a real
 * catalog operation at compile time without making the catalog the source of
 * this list.
 */
export const GRADED_REQUEST_OPERATIONS = [
  'writing.task1.grade',
  'writing.task2.grade',
  'speaking.grading',
  'speaking.grading-json',
] as const satisfies readonly (keyof typeof OPERATION_CATALOG)[];

/**
 * The order in which a graded request authenticates, resolves the End-User
 * ID, passes Graded admission, and takes a concurrency slot (ADR-0018,
 * ADR-0057). Graded admission applies the rate limit, then the retry budget,
 * then the quota, so an exhausted retry is refused before replay or quota
 * handling; all refusals happen before a concurrency slot is taken.
 */
export const GRADED_REQUEST_GUARDS = [
  ApiKeyGuard,
  UserIdentityGuard,
  GradedAdmissionGuard,
] as const;

/**
 * The response side of the same chain. `ConcurrencyPermitInterceptor` acquires
 * the concurrency permit before the handler and releases it after (ADR-0058,
 * issue #172), so the acquire and release halves are one unit no route can
 * split; `SuccessEnvelopeInterceptor` shapes the public response.
 */
export const GRADED_REQUEST_INTERCEPTORS = [
  ConcurrencyPermitInterceptor,
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

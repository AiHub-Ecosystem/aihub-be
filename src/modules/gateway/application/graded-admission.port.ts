import type { OperationId } from '@/catalog/operation-id';

import type { RateLimitStanding } from './rate-limiter.port';

export interface GradedAdmissionRequest {
  readonly apiKeyId: string;
  readonly rateLimitRpm: number;
  readonly organizationId: string;
  readonly requestId: string;
  readonly operation: OperationId;
  readonly idempotencyKey?: string;
  readonly monthlyRequestQuota: number | null;
  readonly hardStopOnQuota: boolean;
}

export type GradedAdmissionDecision =
  /** `quotaUnverified`: the quota counter was lost and could not be rebuilt. */
  (
    | { readonly stage: 'admitted'; readonly quotaUnverified?: true }
    | { readonly stage: 'rate_limit'; readonly retryAfterMs: number }
    | { readonly stage: 'retry_budget'; readonly retryAfterMs: number }
    | { readonly stage: 'quota'; readonly quota: number }
  ) & { readonly rate?: RateLimitStanding };

export interface GradedAdmissionPort {
  consume(request: GradedAdmissionRequest): Promise<GradedAdmissionDecision>;
}

export const GRADED_ADMISSION = Symbol('GRADED_ADMISSION');

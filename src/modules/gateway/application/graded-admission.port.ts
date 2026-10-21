import type { OperationId } from '@/catalog/operation-id';

export interface GradedAdmissionRequest {
  readonly apiKeyId: string;
  readonly rateLimitRpm: number;
  readonly organizationId: string;
  readonly requestId: string;
  readonly operation: OperationId;
  readonly idempotencyKey?: string;
  readonly monthlyRequestQuota: number | null;
}

export type GradedAdmissionDecision =
  | { readonly stage: 'admitted' }
  | { readonly stage: 'rate_limit'; readonly retryAfterMs: number }
  | { readonly stage: 'retry_budget'; readonly retryAfterMs: number }
  | { readonly stage: 'quota'; readonly quota: number };

export interface GradedAdmissionPort {
  consume(request: GradedAdmissionRequest): Promise<GradedAdmissionDecision>;
}

export const GRADED_ADMISSION = Symbol('GRADED_ADMISSION');

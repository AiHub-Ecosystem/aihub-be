export interface QuotaCounterRequest {
  readonly organizationId: string;
}

export interface QuotaCounterPort {
  read(request: QuotaCounterRequest): Promise<number>;
  increment(request: QuotaCounterRequest): Promise<void>;
}

export const QUOTA_COUNTER = Symbol('QUOTA_COUNTER');

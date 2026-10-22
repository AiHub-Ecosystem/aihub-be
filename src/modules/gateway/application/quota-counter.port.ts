export interface QuotaCounterRequest {
  readonly organizationId: string;
}

export interface QuotaCounterPort {
  read(request: QuotaCounterRequest): Promise<number>;
  increment(request: QuotaCounterRequest): Promise<void>;
}

export const QUOTA_COUNTER = Symbol('QUOTA_COUNTER');

/** Rebuilds a monthly quota counter Redis lost, from durable usage (#371). */
export interface QuotaCounterSeedPort {
  seed(organizationId: string, now: Date): Promise<void>;
}

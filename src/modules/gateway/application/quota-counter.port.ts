export interface QuotaCounterRequest {
  readonly organizationId: string;
  readonly occurredAt?: Date;
}

export interface QuotaCounterOverwriteRequest {
  readonly organizationId: string;
  readonly month: string;
  readonly count: number;
}

export interface QuotaCounterReadRequest {
  readonly organizationId: string;
  readonly month: string;
}

export interface QuotaCounterOverwritePort {
  read(request: QuotaCounterReadRequest): Promise<number>;
  overwrite(request: QuotaCounterOverwriteRequest): Promise<void>;
}

export interface QuotaCounterPort {
  read(request: QuotaCounterRequest): Promise<number>;
  increment(request: QuotaCounterRequest): Promise<void>;
}

export const QUOTA_COUNTER = Symbol('QUOTA_COUNTER');
export const QUOTA_COUNTER_OVERWRITE = Symbol('QUOTA_COUNTER_OVERWRITE');

/** Rebuilds a monthly quota counter Redis lost, from durable usage (#371). */
export interface QuotaCounterSeedPort {
  seed(organizationId: string, now: Date): Promise<void>;
}

import type {
  BillingBasis,
  MeteringModel,
  MeteringOutcome,
  MeteringStatus,
  MeteringUsage,
} from './metering-finalizer.port';

export interface UsageRecord {
  readonly requestId: string;
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly actorId?: string;
  readonly service: string;
  readonly operation: string;
  readonly environment: string;
  readonly outcome: MeteringOutcome;
  readonly httpStatus: number;
  readonly errorCode?: string;
  readonly billableRequests: number;
  readonly usage?: MeteringUsage;
  readonly models?: readonly MeteringModel[];
  readonly meteringStatus: MeteringStatus;
  readonly totalMs: number;
  readonly downstreamMs?: number;
  readonly aiProcessingMs?: number;
  readonly billingBasis: BillingBasis;
}

export interface UsageRepositoryPort {
  insert(record: UsageRecord): Promise<void>;
  close?(): Promise<void>;
}

export const USAGE_REPOSITORY = Symbol('USAGE_REPOSITORY');

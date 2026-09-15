import type {
  MeteringModel,
  MeteringOutcome,
  MeteringStatus,
  MeteringUsage,
} from '../../../common/metering/metering.types';

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
}

export interface UsageAggregateQuery {
  readonly organizationId: string;
  readonly from: Date;
  readonly to: Date;
  readonly operation?: string;
}

export interface UsageAggregate {
  readonly billableRequestCount: number;
  readonly billableTokenCount: number;
  readonly missingUsageCount: number;
}

export interface UsageRepositoryPort {
  insert(record: UsageRecord): Promise<void>;
  aggregate(query: UsageAggregateQuery): Promise<UsageAggregate>;
  close?(): Promise<void>;
}

export const USAGE_REPOSITORY = Symbol('USAGE_REPOSITORY');

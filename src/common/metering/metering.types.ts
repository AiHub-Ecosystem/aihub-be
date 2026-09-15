import type { OperationId } from '../../catalog/operation-id';

export type MeteringOutcome =
  | 'success'
  | 'client_error'
  | 'downstream_error'
  | 'internal_error';

export type MeteringStatus =
  | 'complete'
  | 'missing_usage'
  | 'not_applicable'
  | 'quota_unverified';

export interface MeteringUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface MeteringModel {
  readonly provider: string;
  readonly name: string;
}

export interface MeteringTelemetry {
  readonly usage?: MeteringUsage;
  readonly models?: readonly MeteringModel[];
  readonly aiProcessingMs?: number;
}

export interface RequestMeteringState {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly startedAt: number;
  operation?: OperationId;
  organizationId?: string;
  apiKeyId?: string;
  environment?: string;
  actorId?: string;
  downstreamMs?: number;
  aiProcessingMs?: number;
  usage?: MeteringUsage;
  models?: readonly MeteringModel[];
  idempotentReplay?: boolean;
  modelCalled?: boolean;
  quotaUnverified?: boolean;
  finalized: boolean;
}

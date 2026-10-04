import type { OperationId } from '@/catalog/operation-id';

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

export interface MeteringFinalizeInput {
  readonly requestId: string;
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly actorId?: string;
  readonly operation: OperationId;
  readonly environment: string;
  readonly outcome: MeteringOutcome;
  readonly httpStatus: number;
  readonly errorCode?: string;
  readonly usage?: MeteringUsage;
  readonly models?: readonly MeteringModel[];
  readonly totalMs: number;
  readonly downstreamMs?: number;
  readonly aiProcessingMs?: number;
  readonly idempotentReplay?: boolean;
  readonly modelCalled?: boolean;
  readonly quotaTracked?: boolean;
  readonly quotaUnverified?: boolean;
  /**
   * Called with the status the record was finally written with, after every
   * mutation the finalizer applies.
   *
   * The port returns `void`, so without this a reader that needs the persisted
   * status has no way to learn it and recomputes one that can disagree with
   * the record. The callback keeps that knowledge inside metering instead of
   * exposing the record, which stays internal (ADR-0016).
   */
  readonly onStatusWritten?: (status: MeteringStatus) => void;
}

export interface MeteringFinalizerPort {
  finalize(input: MeteringFinalizeInput): Promise<void>;
}

export const METERING_FINALIZER = Symbol('METERING_FINALIZER');

import type { OperationId } from '../../catalog/operation-id';
import type {
  MeteringModel,
  MeteringOutcome,
  MeteringUsage,
} from './metering.types';

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
}

export interface MeteringFinalizerPort {
  finalize(input: MeteringFinalizeInput): Promise<void>;
}

export const METERING_FINALIZER = Symbol('METERING_FINALIZER');

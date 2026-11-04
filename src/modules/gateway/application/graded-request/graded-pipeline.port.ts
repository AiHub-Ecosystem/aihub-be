import type { OperationId } from '@/catalog/operation-id';
import type {
  DispatchResult,
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import type { RateLimitStanding } from '@/modules/gateway/application/rate-limiter.port';
import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { ResolvedUserIdentity } from '@/modules/identity/user-assertions/application/user-identity-resolver.port';
import type {
  MeteringEvidence,
  MeteringGatheredEvidence,
} from '@/modules/metering/public/metering-evidence';

/** Request-scoped effects supplied by the presentation boundary. */
export interface GradedPipelineMetering {
  readonly evidence: MeteringEvidence | undefined;
  setDimensions(dimensions: {
    readonly operation: OperationId;
    readonly identityMode: 'declared_id' | 'signed_assertion' | 'unknown';
    readonly retryBudget: 'keyed_writing' | 'none';
  }): void;
  addEvidence(evidence: Partial<MeteringGatheredEvidence>): void;
  markCompletionStarted(): void;
  markCompletionSettled(): void;
}

export interface GradedPipelineContext<K extends OperationId> {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly signal: AbortSignal;
  readonly dispose: () => void;
  readonly operation: K;
  readonly authenticated: AuthenticatedApiKey;
  readonly identity: ResolvedUserIdentity;
  /** The raw header is resolved only after admission, matching the public error order. */
  readonly idempotencyKey?: string;
  readonly metering: GradedPipelineMetering;
  readonly onRateLimitStanding?: (
    standing: RateLimitStanding | undefined,
  ) => void;
  readonly markAdmission: () => void;
  readonly onDispatchResult?: (
    result: DispatchResult<ResponseFor<K>>,
  ) => void | Promise<void>;
  readonly prepareInput: (
    signal: AbortSignal,
  ) =>
    | PreparedGradedInput<RequestFor<K>>
    | Promise<PreparedGradedInput<RequestFor<K>>>;
}

export interface PreparedGradedInput<TInput> {
  readonly input: TInput;
  readonly release?: () => void;
}

export const GRADED_PIPELINE_COMPLETION = Symbol('GRADED_PIPELINE_COMPLETION');
export type GradedPipelineCompletion = () => Promise<void>;

export type GradedPipelineDispatchResult<T> = DispatchResult<T> & {
  readonly [GRADED_PIPELINE_COMPLETION]?: GradedPipelineCompletion;
};

export interface GradedPipelineEnginePort {
  execute<K extends OperationId>(
    context: GradedPipelineContext<K>,
  ): Promise<GradedPipelineDispatchResult<ResponseFor<K>>>;
}

/** The response boundary signals completion after it has finalized metering. */
export async function completeGradedPipelineResponse(
  value: unknown,
): Promise<void> {
  if (typeof value !== 'object' || value === null) return;
  const completion: unknown = Object.getOwnPropertyDescriptor(
    value,
    GRADED_PIPELINE_COMPLETION,
  )?.value;
  if (typeof completion === 'function') {
    await (completion as GradedPipelineCompletion)();
  }
}

export const GRADED_PIPELINE_ENGINE = Symbol('GRADED_PIPELINE_ENGINE');

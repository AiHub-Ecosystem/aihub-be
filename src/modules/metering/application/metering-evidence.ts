import type { OperationId } from '@/catalog/operation-id';
import type {
  MeteringModel,
  MeteringStatus,
  MeteringUsage,
} from './metering-finalizer.port';

/**
 * What one authenticated request has gathered so far on its way to becoming a
 * Metering record (ADR-0061). The first four fields are the record's required
 * shape, supplied by the guard that authenticated the request; everything
 * below them is evidence gathered later, and none of it is required.
 *
 * This lives on the request, beside the identity, actor, and concurrency
 * fields the gateway already attaches there, so no module-level store is
 * shared between unrelated modules.
 */
export interface MeteringEvidence {
  readonly operation: OperationId;
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly environment: string;
  actorId?: string;
  downstreamMs?: number;
  aiProcessingMs?: number;
  /**
   * The status the Metering record was finally written with, stamped by the
   * finalizer after every mutation it may apply.
   *
   * It lives on the evidence rather than being recomputed by a reader,
   * because the record's status is not decided in one place: the finalizer can
   * still overwrite `missing_usage` with `quota_unverified` when the quota
   * counter rejects. A reader that recomputed the status would report the
   * intent rather than the persisted truth — the same distinction ADR-0026
   * draws when it says the completeness report trusts the finalized status
   * instead of recomputing token validity.
   */
  meteringStatus?: MeteringStatus;
  /** The total time the Metering record was written with; also the one the Request Completion Event reports. */
  totalMs?: number;
  usage?: MeteringUsage;
  models?: readonly MeteringModel[];
  idempotentReplay?: boolean;
  modelCalled?: boolean;
  quotaTracked?: boolean;
  quotaUnverified?: boolean;
  settled: boolean;
}

/**
 * What a later writer may add. The required shape is not in here, so no writer
 * after the authenticating guard can change which request it belongs to.
 */
export type MeteringGatheredEvidence = Omit<
  MeteringEvidence,
  | 'operation'
  | 'organizationId'
  | 'apiKeyId'
  | 'environment'
  | 'settled'
  // The finalizer alone decides the record's status, so no gathered writer can
  // claim to know it. The finalizer stamps it directly on the evidence.
  | 'meteringStatus'
>;

declare module 'fastify' {
  interface FastifyRequest {
    aihubMetering?: MeteringEvidence;
  }
}

export function getMeteringEvidence(
  request: unknown,
): MeteringEvidence | undefined {
  return isObject(request) ? request.aihubMetering : undefined;
}

function isObject(
  value: unknown,
): value is { aihubMetering?: MeteringEvidence } {
  return typeof value === 'object' && value !== null;
}

/**
 * The authenticating guard opens the evidence, because it is the only writer
 * that knows the required shape.
 */
export function openMeteringEvidence(
  request: { aihubMetering?: MeteringEvidence },
  identity: {
    readonly operation: OperationId;
    readonly organizationId: string;
    readonly apiKeyId: string;
    readonly environment: string;
  },
): void {
  request.aihubMetering ??= { ...identity, settled: false };
}

/**
 * Every later writer adds what it knows and touches nothing else. A later
 * writer that names an operation must name the same one, so the operation is
 * not spreadable and the guard's answer stays the one that was routed on.
 */
export function addMeteringEvidence(
  request: { aihubMetering?: MeteringEvidence },
  evidence: Partial<MeteringGatheredEvidence>,
): void {
  const existing = request.aihubMetering;
  if (existing === undefined) {
    return;
  }

  for (const [key, value] of Object.entries(evidence)) {
    if (value !== undefined) {
      Object.assign(existing, { [key]: value });
    }
  }
}

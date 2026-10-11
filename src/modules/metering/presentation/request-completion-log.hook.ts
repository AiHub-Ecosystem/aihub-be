import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { OPERATION_IDS, type OperationId } from '@/catalog/operation-id';
import type { ErrorCode } from '@/common/errors/error-code';
import { isHealthProbe } from '@/common/http/request-path';
import {
  requestAdmissionMs,
  requestDurationMs,
} from '@/common/http/request-timing.hook';
import { routeTemplate } from '@/common/http/request-tracing.hook';
import {
  METRICS_ROUTE_PATH,
  recordCompletedRequest,
} from '@/common/observability/metrics';
import {
  type MeteringEvidence,
  getMeteringEvidence,
} from '@/modules/metering/application/metering-evidence';
import type { MeteringOutcome } from '@/modules/metering/application/metering-finalizer.port';
import { requestOutcome } from '@/modules/metering/application/request-outcome';

const COMPLETION_EVENT = 'request_completed';
const OPERATION_BY_ROUTE = new Map<string, OperationId>(
  OPERATION_IDS.map((operationId) => {
    const operation = OPERATION_CATALOG[operationId];
    return [`${operation.method} ${operation.path}`, operationId] as const;
  }),
);

/**
 * One response, as the log records it. A field with no value is left out
 * entirely, so a query on it means the request genuinely carried one.
 */
interface RequestCompletionEvent {
  readonly event: typeof COMPLETION_EVENT;
  readonly request_id: string;
  readonly method: string;
  readonly route: string;
  readonly http_status: number;
  readonly total_ms: number;
  readonly admission_ms?: number;
  readonly outcome: MeteringOutcome;
  readonly error_code?: ErrorCode;
  readonly org_id?: string;
  readonly operation?: OperationId;
  readonly environment?: string;
  readonly trace_id?: string;
}

/**
 * The event is assembled field by field from a fixed allowlist: request,
 * headers, body, query, and error object are never in scope here, so nothing
 * sensitive has a path into the log.
 */
function completionEvent(
  request: FastifyRequest,
  reply: FastifyReply,
): RequestCompletionEvent {
  const evidence = getMeteringEvidence(request);
  const errorCode = request.aihubFailureCode;
  const traceId = request.aihubTraceId;
  const statusCode = reply.statusCode;
  const admissionMs = requestAdmissionMs(request.raw);

  return {
    event: COMPLETION_EVENT,
    request_id: String(request.id),
    method: request.method,
    route: routeTemplate(request),
    http_status: statusCode,
    // Authenticated requests reuse the Metering value; requests without a
    // record use the same ingress clock directly.
    total_ms:
      evidence?.totalMs ?? requestDurationMs(request.raw, reply.elapsedTime),
    ...(admissionMs === undefined ? {} : { admission_ms: admissionMs }),
    outcome: requestOutcome(statusCode, errorCode),
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    ...(evidence === undefined
      ? {}
      : {
          org_id: evidence.organizationId,
          operation: evidence.operation,
          environment: evidence.environment,
        }),
    ...(traceId === undefined ? {} : { trace_id: traceId }),
  };
}

/**
 * The same completion, as counters. Reads the same evidence as the log line,
 * so a metric and a log line can never disagree about one request.
 *
 * Authenticated requests use Metering evidence. A pre-auth refusal can still
 * use a bounded label when its matched method and route exactly name a catalog
 * operation. Never derive labels from the caller's raw URL.
 */
function recordRequestMetrics(
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const evidence = getMeteringEvidence(request);
  const operation =
    evidence?.operation ??
    OPERATION_BY_ROUTE.get(`${request.method} ${routeTemplate(request)}`);
  if (operation === undefined) {
    return;
  }

  const outcome = requestOutcome(reply.statusCode, request.aihubFailureCode);
  const tokens = evidence === undefined ? undefined : tokensOf(evidence);
  const admissionMs = requestAdmissionMs(request.raw);

  recordCompletedRequest({
    operation,
    statusCode: reply.statusCode,
    outcome,
    totalMs:
      evidence?.totalMs ?? requestDurationMs(request.raw, reply.elapsedTime),
    ...(admissionMs === undefined ? {} : { admissionMs }),
    ...(evidence?.downstreamMs === undefined
      ? {}
      : { downstreamMs: evidence.downstreamMs }),
    ...(tokens === undefined ? {} : { tokens }),
    // Read from the evidence rather than recomputed: the finalizer stamps this
    // after applying every mutation, so it is the status the record was
    // actually written with. Absent when the record was never finalized.
    ...(evidence?.meteringStatus === undefined
      ? {}
      : { meteringStatus: evidence.meteringStatus }),
  });
}

/**
 * The downstream reports input, output, and a total, and any one of them may
 * be absent. `total` is authoritative when present; otherwise the reported
 * parts are summed. A downstream that reported neither contributes nothing
 * rather than a fabricated zero, which is what `aihub_tokens_total` would
 * otherwise record as a real zero-token request.
 */
function tokensOf(evidence: MeteringEvidence): number | undefined {
  const usage = evidence.usage;
  if (usage === undefined) {
    return undefined;
  }

  if (usage.totalTokens !== undefined) {
    return usage.totalTokens;
  }

  const parts = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return parts > 0 ? parts : undefined;
}

/**
 * One event per response, from `onResponse`, which is the one lifecycle point
 * that sees every reply: matched routes, 404s, framework parse errors, and
 * rejections that happen before Nest does. A request the client abandons
 * never reaches it, so a line always means a response went out.
 *
 * The hook belongs to metering rather than the shared HTTP layer because the
 * Organization, operation, and environment it reports live in Metering
 * evidence, which this module owns (ADR-0061).
 */
export function registerRequestCompletionLog(instance: FastifyInstance): void {
  const log = instance.log;

  instance.addHook('onResponse', (request, reply, done) => {
    const isProbe = isHealthProbe(request.url);

    if (request.url === METRICS_ROUTE_PATH) {
      // A scrape is not a customer request. It carries no metering evidence,
      // so it would be skipped below anyway, but it also must not be logged.
      return done();
    }

    if (!isProbe) {
      log.info(completionEvent(request, reply));
      recordRequestMetrics(request, reply);
    }

    done();
  });
}

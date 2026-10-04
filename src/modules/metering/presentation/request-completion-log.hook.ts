import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { ErrorCode } from '@/common/errors/error-code';
import { isHealthProbe } from '@/common/http/request-path';
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
import {
  DOWNSTREAM_USAGE_REPORTING,
  resolveMeteringStatus,
} from '@/modules/metering/application/metering.service';
import { requestOutcome } from '@/modules/metering/application/request-outcome';

const COMPLETION_EVENT = 'request_completed';

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

  return {
    event: COMPLETION_EVENT,
    request_id: String(request.id),
    method: request.method,
    route: routeTemplate(request),
    http_status: statusCode,
    // An authenticated request reports the number its Metering record was
    // written with, so the line and the record cannot disagree about one
    // request. A request that never authenticated has no record, and reports
    // Fastify's own response window: from the request arriving to the response
    // finishing, which excludes body-parse time.
    total_ms: evidence?.totalMs ?? Math.max(0, Math.round(reply.elapsedTime)),
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
 * A request with no operation identifier never reaches an operation: it was
 * rejected before authentication, or it matched no catalog route. There is no
 * bounded label value to attribute it to, and inventing one from the URL would
 * let a caller mint unbounded series by requesting arbitrary paths, so it is
 * counted nowhere rather than miscounted. Rejections that matter to an
 * operator are counted by #200 from the protection seam itself.
 */
function recordRequestMetrics(
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const evidence = getMeteringEvidence(request);
  if (evidence === undefined) {
    return;
  }

  const outcome = requestOutcome(reply.statusCode, request.aihubFailureCode);
  const operation = OPERATION_CATALOG[evidence.operation];
  const tokens = tokensOf(evidence);

  recordCompletedRequest({
    operation: evidence.operation,
    statusCode: reply.statusCode,
    outcome,
    totalMs: evidence.totalMs ?? Math.max(0, Math.round(reply.elapsedTime)),
    ...(evidence.downstreamMs === undefined
      ? {}
      : { downstreamMs: evidence.downstreamMs }),
    ...(tokens === undefined ? {} : { tokens }),
    meteringStatus: resolveMeteringStatus({
      mode: operation.meteringMode,
      usageReportingExpected: DOWNSTREAM_USAGE_REPORTING[operation.downstream],
      ...(evidence.usage === undefined ? {} : { usage: evidence.usage }),
      ...(evidence.quotaUnverified === undefined
        ? {}
        : { quotaUnverified: evidence.quotaUnverified }),
      modelCalled: evidence.modelCalled ?? outcome === 'success',
    }),
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

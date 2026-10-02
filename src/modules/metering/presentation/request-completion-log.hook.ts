import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { OperationId } from '../../../catalog/operation-id';
import type { ErrorCode } from '../../../common/errors/error-code';
import { isHealthProbe } from '../../../common/http/request-path';
import { routeTemplate } from '../../../common/http/request-tracing.hook';
import { getMeteringEvidence } from '../application/metering-evidence';
import type { MeteringOutcome } from '../application/metering-finalizer.port';
import { requestOutcome } from '../application/request-outcome';

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
    if (!isHealthProbe(request.url)) {
      log.info(completionEvent(request, reply));
    }

    done();
  });
}

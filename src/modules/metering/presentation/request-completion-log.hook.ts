import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { readRequestFailure } from '../../../common/http/request-failure.recorder';
import { isHealthProbe } from '../../../common/http/request-path';
import { readRequestTraceId } from '../../../common/http/request-tracing.hook';
import { getMeteringEvidence } from '../application/metering-evidence';
import { completionOutcome } from '../application/request-outcome';

const COMPLETION_EVENT = 'request_completed';
const UNMATCHED_ROUTE = 'unmatched';

/**
 * The event is assembled field by field from a fixed allowlist: request,
 * headers, body, query, and error object are never in scope here, so nothing
 * sensitive has a path into the log. A field with no value is left out
 * entirely, so a query on it means the request genuinely carried one.
 */
function completionEvent(
  request: FastifyRequest,
  reply: FastifyReply,
): Record<string, unknown> {
  const evidence = getMeteringEvidence(request);
  const errorCode = readRequestFailure(request.raw);
  const traceId = readRequestTraceId(request.raw);
  const statusCode = reply.statusCode;

  return {
    event: COMPLETION_EVENT,
    request_id: String(request.id),
    method: request.method,
    route: request.routeOptions.url ?? UNMATCHED_ROUTE,
    http_status: statusCode,
    // Fastify's own response window: the transport's own measurement, from the
    // request arriving to the response finishing. A failed request's Metering
    // record stores exactly this number. A successful request's record instead
    // measures the handler and its envelope from inside the interceptor, so on
    // that path the two numbers differ — a pre-existing difference that this
    // slice records rather than changes, because the Metering record is out of
    // scope here.
    total_ms: Math.max(0, Math.round(reply.elapsedTime)),
    outcome: completionOutcome(statusCode, errorCode),
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

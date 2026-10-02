import {
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  context,
  trace,
} from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isHealthProbe } from './request-path';

interface RequestTraceState {
  readonly span: Span;
}

const traces = new WeakMap<object, RequestTraceState>();

/**
 * Kept apart from `traces` because that map is emptied the moment the span
 * ends, while a consumer reporting after the response — the Request Completion
 * Event — still needs the id. A `WeakMap` entry costs nothing to leave behind:
 * the request object owns its own lifetime.
 */
const traceIds = new WeakMap<object, string>();

/**
 * The trace this request is running inside, for a consumer that reports once
 * the span has ended. `undefined` when request tracing is not registered.
 */
export function readRequestTraceId(rawRequest: unknown): string | undefined {
  return typeof rawRequest === 'object' && rawRequest !== null
    ? traceIds.get(rawRequest)
    : undefined;
}

function routeTemplate(request: FastifyRequest): string {
  return request.routeOptions.url ?? 'unmatched';
}

function finishRequest(request: FastifyRequest, statusCode?: number): void {
  const state = traces.get(request.raw);
  if (state === undefined) {
    return;
  }

  traces.delete(request.raw);
  if (statusCode !== undefined) {
    state.span.setAttribute('http.response.status_code', statusCode);
    if (statusCode >= 500) {
      state.span.setStatus({ code: SpanStatusCode.ERROR });
    }
  }
  state.span.end();
}

export function registerRequestTracing(
  instance: FastifyInstance,
  tracer: Tracer,
): void {
  instance.addHook('onRequest', (request, _reply, done) => {
    if (isHealthProbe(request.url)) {
      done();
      return;
    }

    const route = routeTemplate(request);
    const span = tracer.startSpan(
      `${request.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': request.method,
          'http.route': route,
          'aihub.request_id': String(request.id),
        },
      },
      context.active(),
    );

    traces.set(request.raw, { span });
    traceIds.set(request.raw, span.spanContext().traceId);
    const requestContext = trace.setSpan(context.active(), span);
    context.with(requestContext, done);
  });

  instance.addHook('onResponse', (request, reply, done) => {
    finishRequest(request, reply.statusCode);
    done();
  });

  instance.addHook('onRequestAbort', (request, done) => {
    const state = traces.get(request.raw);
    state?.span.setAttribute('aihub.request_aborted', true);
    finishRequest(request);
    done();
  });

  instance.addHook('onTimeout', (request, _reply, done) => {
    const state = traces.get(request.raw);
    state?.span.setAttribute('aihub.request_timed_out', true);
    state?.span.setStatus({ code: SpanStatusCode.ERROR });
    finishRequest(request);
    done();
  });
}

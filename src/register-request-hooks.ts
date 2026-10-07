import type { Tracer } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';

import { registerBodySizeGuard } from './common/http/body-size.hook';
import { registerRequestLifecycle } from './common/http/request-lifecycle.hook';
import { registerRequestTracing } from './common/http/request-tracing.hook';
import { registerSecurityHeaders } from './common/http/security-headers.hook';
import { registerRequestCompletionLog } from './modules/metering/presentation/request-completion-log.hook';

/**
 * Every Fastify hook the application runs around a request, in the order the
 * bootstrap registers them. One function so the test of the shipped request log
 * runs the same set, in the same order, rather than a copy that can drift.
 *
 * Registered directly on the raw Fastify instance rather than through Nest's
 * own middleware/guard pipeline, so each runs before the body is parsed.
 */
export function registerRequestHooks(
  instance: FastifyInstance,
  tracer: Tracer | undefined,
): void {
  // Start the root span before other request hooks. Route templates keep paths
  // bounded and prevent raw request URLs or query values entering traces.
  if (tracer !== undefined) {
    registerRequestTracing(instance, tracer);
  }

  registerBodySizeGuard(instance);
  registerRequestLifecycle(instance);
  registerSecurityHeaders(instance);

  // Registered last: tracing owns the span this line names, and the lifecycle
  // hook must already have let the `onResponse` chain through to reach it.
  registerRequestCompletionLog(instance);
}

import type { Tracer } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';

import { registerBodySizeGuard } from './common/http/body-size.hook';
import { registerRequestIdResponseHeader } from './common/http/request-id-response-header.hook';
import { registerRequestLifecycle } from './common/http/request-lifecycle.hook';
import { registerRequestTiming } from './common/http/request-timing.hook';
import { registerRequestTracing } from './common/http/request-tracing.hook';
import { registerSecurityHeaders } from './common/http/security-headers.hook';
import {
  registerPublicApiMajorUsage,
  registerRequestCompletionLog,
} from './modules/metering/public/http-hooks';
import type { RequestTier } from './modules/gateway/application/shedding/request-tier';
import type { SheddingLevelPort } from './modules/gateway/application/shedding/shedding-level.port';
import { registerSheddingGuard } from './modules/gateway/presentation/shedding.hook';
import type { PublicApiMajorUsageSample } from './modules/metering/public/public-api-major-usage';

/** Prioritized load shedding, bound to wherever the gateway reports its tiers. */
export interface SheddingHookOptions {
  readonly level: SheddingLevelPort;
  readonly record: (tier: RequestTier, outcome: 'admitted' | 'shed') => void;
}

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
  recordPublicApiMajorUsage?: (sample: PublicApiMajorUsageSample) => void,
  shedding?: SheddingHookOptions,
): void {
  // Capture ingress before tracing, body-size rejection, parsing, and Nest guards.
  registerRequestTiming(instance);

  // Start the root span before other request hooks. Route templates keep paths
  // bounded and prevent raw request URLs or query values entering traces.
  if (tracer !== undefined) {
    registerRequestTracing(instance, tracer);
  }

  // After tracing so a shed request still carries a span, and before the
  // body-size guard so neither reads a body for a request it will refuse.
  if (shedding !== undefined) {
    registerSheddingGuard(instance, shedding.level, shedding.record);
  }

  registerBodySizeGuard(instance);
  registerRequestLifecycle(instance);
  registerSecurityHeaders(instance);
  registerRequestIdResponseHeader(instance);

  // Registered last: tracing owns the span this line names, and the lifecycle
  // hook must already have let the `onResponse` chain through to reach it.
  registerRequestCompletionLog(instance);

  // Absent in specs that run the hooks without the Metering module's buffer.
  if (recordPublicApiMajorUsage !== undefined) {
    registerPublicApiMajorUsage(instance, recordPublicApiMajorUsage);
  }
}

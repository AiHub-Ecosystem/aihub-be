import type { FastifyInstance } from 'fastify';

import {
  METRICS_ROUTE_PATH,
  getMetrics,
  getMetricsContentType,
} from './metrics';

/**
 * The scrape endpoint. Registered directly on the raw Fastify instance the
 * way the body-size guard is, so it bypasses Nest's middleware pipeline and
 * never enters the operation catalog or the generated OpenAPI document: it is
 * infrastructure, not a public API operation.
 *
 * It deliberately carries no authentication. Prometheus has no browser
 * redirect to satisfy and no cookie to carry, so an auth challenge would
 * reduce to a shared-secret header — the same secret the scrape config would
 * then have to hold. The endpoint exposes operation identifiers, status codes
 * and latencies, which are already visible to any caller of the API, and it
 * must be reachable by whatever scrapes it.
 *
 * What keeps it off the public edge is the TLS terminator in front of the
 * application, which must not proxy this path. That configuration lives on
 * the host rather than in this repository, so this comment records the
 * obligation instead of claiming a guarantee this code cannot make: the
 * container's own published port is bound to loopback, but the process
 * itself listens on every interface.
 */
export function registerMetricsRoute(instance: FastifyInstance): void {
  instance.get(METRICS_ROUTE_PATH, async (_request, reply) => {
    try {
      const payload = await getMetrics();
      return reply
        .header('content-type', getMetricsContentType())
        .send(payload);
    } catch {
      // A collection failure must not read as an empty-but-healthy scrape,
      // which a dashboard would plot as "traffic went to zero".
      return reply.status(500).send('metrics collection failed\n');
    }
  });
}

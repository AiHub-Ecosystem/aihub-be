# ADR-0063: Trace request stages through OTLP

- Status: Accepted
- Date: 2026-09-29
- Supersedes: Stage A tracing deferral in [01-context-and-stack](../superpowers/specs/2026-09-07-aihub/01-context-and-stack.md) and [10-deployment-roadmap](../superpowers/specs/2026-09-07-aihub/10-deployment-roadmap.md)

## Context

AIHUB is a synchronous proxy. Its existing timing covered the downstream call,
but did not show the individual Redis and Postgres waits that contribute to a
request. The earlier Stage A decision deferred distributed tracing because the
service had few downstreams and no dedicated DevOps capacity. That left latency
investigation unable to separate gateway work from cache, database, pool, and
downstream delays.

## Decision

Use the OpenTelemetry Node SDK with narrowly selected instrumentation for
Fastify request lifecycles, ioredis, `pg`, and Undici. Start one server span per
request from the route template and AIHUB-generated request ID; attach client
spans for each Redis command, Postgres operation, and downstream HTTP request.
Propagate W3C trace context downstream, without baggage.

Export spans with OTLP/HTTP only when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is
configured. Batch export away from the response path. Do not add a collector or
trace store to the application Compose stack; operators provide a reachable
receiver. Trace every request while enabled.

Limit recorded detail: serialize Redis commands without keys or arguments,
replace SQL text with its operation name, and use route templates instead of
raw request URLs. Downstream HTTP spans keep only the URL origin and path;
credentials and query values are removed. Do not attach payloads, credentials,
headers, or downstream bodies. Keep Postgres trace-context SQL comments
disabled to avoid an extra database round trip per query.

## Consequences

- A single trace shows request total time and the durations of individual
  Redis, Postgres, connection-pool, and downstream operations.
- Tracing is disabled unless an OTLP/HTTP receiver is configured, and a trace
  UI or storage backend remains an operator responsibility.
- Instrumentation adds runtime overhead while enabled; batching keeps export
  outside the request path, but production overhead still needs measurement.
- The former “no distributed tracing in Stage A” choice is superseded. The
  application still avoids deploying another observability service itself.

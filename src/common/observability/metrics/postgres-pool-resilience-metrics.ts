import { Counter, Histogram } from '@prometheus-io/client';

import { type PostgresPoolName, registry } from './metrics';

export type PostgresBreakerState = 'closed' | 'open' | 'half_open';

const connectRetryLatency = new Histogram({
  name: 'aihub_postgres_pool_connect_retry_latency_seconds',
  help: 'Time a retried PostgreSQL connection attempt took, by pool and outcome.',
  labelNames: ['pool', 'outcome'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

const backoffDelay = new Histogram({
  name: 'aihub_postgres_pool_backoff_delay_seconds',
  help: 'Decorrelated jittered wait chosen before each PostgreSQL connection retry.',
  labelNames: ['pool'],
  buckets: [0.01, 0.02, 0.04, 0.07, 0.1],
  registers: [registry],
});

const breakerTransitions = new Counter({
  name: 'aihub_postgres_pool_breaker_transitions_total',
  help: 'Pool-starvation circuit breaker state changes by pool and the state entered.',
  labelNames: ['pool', 'state'],
  registers: [registry],
});

const shedTotal = new Counter({
  name: 'aihub_postgres_pool_shed_total',
  help: 'Connection requests refused at once because the pool-starvation breaker is not closed.',
  labelNames: ['pool'],
  registers: [registry],
});

export function observePostgresConnectRetry(
  pool: PostgresPoolName,
  delayMs: number,
): void {
  backoffDelay.observe({ pool }, delayMs / 1_000);
}

export function observePostgresConnectRetryLatency(
  pool: PostgresPoolName,
  outcome: 'success' | 'failure',
  latencyMs: number,
): void {
  connectRetryLatency.observe({ pool, outcome }, latencyMs / 1_000);
}

export function recordPostgresBreakerTransition(
  pool: PostgresPoolName,
  state: PostgresBreakerState,
): void {
  breakerTransitions.inc({ pool, state });
}

export function recordPostgresPoolShed(pool: PostgresPoolName): void {
  shedTotal.inc({ pool });
}

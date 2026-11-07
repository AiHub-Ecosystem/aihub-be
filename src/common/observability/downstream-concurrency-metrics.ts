import { Counter, Gauge, type Registry } from '@prometheus-io/client';

import { registry as sharedRegistry } from './metrics';

export interface DownstreamConcurrencySample {
  readonly origin: string;
  readonly limit: number;
  readonly inFlight: number;
  readonly rttMinMs: number;
  readonly rttAvgMs: number;
}

type DownstreamConcurrencySource = () => readonly DownstreamConcurrencySample[];

let downstreamConcurrencySource: DownstreamConcurrencySource | undefined;

function makeGauge(
  registry: Registry,
  name: string,
  help: string,
  value: 'limit' | 'rttMinMs' | 'rttAvgMs',
): Gauge<'origin'> {
  return new Gauge({
    name,
    help,
    labelNames: ['origin'],
    registers: [registry],
    collect() {
      readDownstreamConcurrency(this, value);
    },
  });
}

const concurrencyLimit = makeGauge(
  sharedRegistry,
  'aihub_downstream_concurrency_limit',
  'Adaptive concurrency limit for each configured downstream origin.',
  'limit',
);
const rttMinSeconds = makeGauge(
  sharedRegistry,
  'aihub_downstream_rtt_min_seconds',
  'Long-term exponentially smoothed round-trip time baseline in seconds per configured downstream origin.',
  'rttMinMs',
);
const rttAvgSeconds = makeGauge(
  sharedRegistry,
  'aihub_downstream_rtt_avg_seconds',
  'Exponentially weighted average round-trip time in seconds per configured downstream origin, including in-flight requests.',
  'rttAvgMs',
);

const limitDropped = new Counter({
  name: 'aihub_downstream_limit_dropped_total',
  help: 'Downstream requests refused because the adaptive concurrency limit was already reached, by configured origin.',
  labelNames: ['origin'],
  registers: [sharedRegistry],
});

function readDownstreamConcurrency(
  gauge: Gauge<'origin'>,
  value: 'limit' | 'rttMinMs' | 'rttAvgMs',
): void {
  gauge.reset();
  try {
    for (const sample of downstreamConcurrencySource?.() ?? []) {
      gauge.set(
        { origin: sample.origin },
        value === 'limit' ? sample.limit : sample[value] / 1000,
      );
    }
  } catch {
    gauge.reset();
  }
}

export function setDownstreamConcurrencySource(
  source: DownstreamConcurrencySource | undefined,
): void {
  downstreamConcurrencySource = source;
  if (source === undefined) {
    concurrencyLimit.reset();
    rttMinSeconds.reset();
    rttAvgSeconds.reset();
  }
}

export { sharedRegistry as registry };

export function recordDownstreamLimitDropped(origin: string): void {
  limitDropped.inc({ origin });
}

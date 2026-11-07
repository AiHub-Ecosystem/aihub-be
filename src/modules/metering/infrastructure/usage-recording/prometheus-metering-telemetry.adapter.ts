import { Counter, Histogram } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics';
import type {
  MeteringTelemetryPort,
  MeteringWriteOutcome,
} from '@/modules/metering/application/usage-recording/metering-telemetry.port';

const writeDuration = new Histogram({
  name: 'aihub_metering_write_duration_seconds',
  help: 'Time spent waiting on the Metering write per request.',
  labelNames: ['outcome'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

const writeFailures = new Counter({
  name: 'aihub_metering_write_failed_total',
  help: 'Metering writes that did not complete, by reason.',
  labelNames: ['reason'],
  registers: [registry],
});

export class PrometheusMeteringTelemetryAdapter
  implements MeteringTelemetryPort
{
  writeDurationSeconds(outcome: MeteringWriteOutcome, seconds: number): void {
    try {
      writeDuration.observe({ outcome }, seconds);
    } catch {
      // Metrics must never affect a completed customer response.
    }
  }

  writeFailed(reason: Exclude<MeteringWriteOutcome, 'success'>): void {
    try {
      writeFailures.inc({ reason });
    } catch {
      // Metrics must never affect a completed customer response.
    }
  }
}

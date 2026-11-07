export type MeteringWriteOutcome = 'success' | 'timeout' | 'error';

export interface MeteringTelemetryPort {
  writeDurationSeconds(outcome: MeteringWriteOutcome, seconds: number): void;
  writeFailed(reason: Exclude<MeteringWriteOutcome, 'success'>): void;
}

export const METERING_TELEMETRY = Symbol('METERING_TELEMETRY');

import type { UsageRecord } from './usage-repository.port';

export interface MeteringFailureLoggerPort {
  writeFailed(record: UsageRecord, reason?: 'timeout' | 'error'): void;
}

export const METERING_FAILURE_LOGGER = Symbol('METERING_FAILURE_LOGGER');

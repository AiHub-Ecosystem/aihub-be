import type { DispatchAttemptRecordPort } from '@/modules/metering/application/usage-recording/dispatch-attempt-record.port';

export const noOpDispatchAttemptRecord: DispatchAttemptRecordPort = {
  beginAttempt: async () => 'test-dispatch-attempt',
  recordOutcome: async () => undefined,
};

import { Counter } from '@prometheus-io/client';

import { registry } from './metrics';

export type RejectionReason = 'rate_limit' | 'quota' | 'concurrency' | 'auth';

const REJECTION_REASONS: readonly RejectionReason[] = [
  'rate_limit',
  'quota',
  'concurrency',
  'auth',
];

const rejectedTotal = new Counter({
  name: 'aihub_rejected_total',
  help: 'Requests refused at a protection or authentication admission seam, by reason.',
  labelNames: ['reason'],
  registers: [registry],
});

for (const reason of REJECTION_REASONS) {
  rejectedTotal.inc({ reason }, 0);
}

export function recordRejected(reason: RejectionReason): void {
  try {
    rejectedTotal.inc({ reason });
  } catch {
    // A metrics failure must not change the admission decision.
  }
}

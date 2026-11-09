import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics';
import type { SpeakingAudioUrlRejectionReason } from '@/modules/speaking/application/audio/speaking-audio-url.policy';

const REASONS: readonly SpeakingAudioUrlRejectionReason[] = [
  'malformed',
  'traversal',
  'foreign_tenant',
  'unapproved_bucket',
];

const rejectedAudioUrls = new Counter({
  name: 'aihub_speaking_audio_url_rejected_total',
  help: 'Speaking grading audio URLs refused by the URL policy, by reason.',
  labelNames: ['reason'],
  registers: [registry],
});

for (const reason of REASONS) {
  rejectedAudioUrls.inc({ reason }, 0);
}

export function recordSpeakingAudioUrlRejection(
  reason: SpeakingAudioUrlRejectionReason,
): void {
  try {
    rejectedAudioUrls.inc({ reason });
  } catch {
    // A metrics failure must not change the admission decision.
  }
}

import type { SpeakingAudioUrlRejectionReason } from './speaking-audio-url.policy';

export interface SpeakingAudioUrlRejectionRecorderPort {
  /** Records one refused `audio_url`; the reason is the only dimension. */
  record(reason: SpeakingAudioUrlRejectionReason): void;
}

export const SPEAKING_AUDIO_URL_REJECTION_RECORDER = Symbol(
  'SPEAKING_AUDIO_URL_REJECTION_RECORDER',
);

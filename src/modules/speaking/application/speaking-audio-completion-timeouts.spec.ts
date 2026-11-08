import {
  SPEAKING_AUDIO_COMPLETION_DEADLINE_MS,
  SPEAKING_AUDIO_COMPLETION_IDLE_TRANSACTION_TIMEOUT_MS,
  SPEAKING_AUDIO_COMPLETION_TRANSACTION_TIMEOUT_MS,
} from './speaking-audio-completion-timeouts';

describe('Speaking Audio completion timeouts', () => {
  it('keeps the storage deadline, transaction timeout, and idle timeout ordered', () => {
    expect(SPEAKING_AUDIO_COMPLETION_DEADLINE_MS).toBeLessThan(
      SPEAKING_AUDIO_COMPLETION_TRANSACTION_TIMEOUT_MS,
    );
    expect(
      SPEAKING_AUDIO_COMPLETION_TRANSACTION_TIMEOUT_MS,
    ).toBeLessThanOrEqual(
      SPEAKING_AUDIO_COMPLETION_IDLE_TRANSACTION_TIMEOUT_MS,
    );
  });
});

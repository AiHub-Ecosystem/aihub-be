import {
  SPEAKING_AUDIO_ORG_INTENT_ISSUANCE_MAX,
  SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX,
  SPEAKING_AUDIO_ORG_STORED_BYTES_MAX,
  decideSpeakingAudioCeiling,
} from './speaking-audio-org-ceiling.policy';

const WITHIN = { openIntents: 0, issuedInWindow: 0, storedBytes: 0 } as const;

describe('decideSpeakingAudioCeiling (#374)', () => {
  it('accepts an Organization holding nothing', () => {
    expect(decideSpeakingAudioCeiling(WITHIN, 1_024)).toEqual({
      kind: 'within',
    });
  });

  it('refuses past the open-intent ceiling with a retryable rate limit', () => {
    const decision = decideSpeakingAudioCeiling(
      { ...WITHIN, openIntents: SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX },
      1_024,
    );

    expect(decision).toMatchObject({
      kind: 'refused',
      refusal: { code: 'RATE_LIMITED', retryable: true },
    });
  });

  it('refuses past the issuance ceiling with the window as its hint', () => {
    const decision = decideSpeakingAudioCeiling(
      { ...WITHIN, issuedInWindow: SPEAKING_AUDIO_ORG_INTENT_ISSUANCE_MAX },
      1_024,
    );

    expect(decision).toMatchObject({
      kind: 'refused',
      refusal: { code: 'RATE_LIMITED', retryable: true },
    });
  });

  it('refuses a stored-bytes overflow as a non-retryable quota', () => {
    const decision = decideSpeakingAudioCeiling(
      { ...WITHIN, storedBytes: SPEAKING_AUDIO_ORG_STORED_BYTES_MAX },
      1_024,
    );

    expect(decision).toMatchObject({
      kind: 'refused',
      refusal: { code: 'QUOTA_EXCEEDED', retryable: false },
    });
  });

  it('accepts a size that lands exactly on the storage ceiling', () => {
    expect(
      decideSpeakingAudioCeiling(
        { ...WITHIN, storedBytes: SPEAKING_AUDIO_ORG_STORED_BYTES_MAX - 1_024 },
        1_024,
      ),
    ).toEqual({ kind: 'within' });
  });

  it('bounds outstanding upload bytes by open intents times the intent ceiling', () => {
    // Eight open intents of at most 25 MiB each is the worst case the open
    // ceiling allows, and it stays under the stored-bytes ceiling.
    expect(SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX * 25 * 1024 * 1024).toBeLessThan(
      SPEAKING_AUDIO_ORG_STORED_BYTES_MAX,
    );
  });
});

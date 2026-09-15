export const SPEAKING_AUDIO_URL_MAX_LENGTH = 2_048;
export const SPEAKING_AUDIO_URL_HOST = 'storage.wispace.vn';

/**
 * The gateway validates the URL shape and approved object-storage origin but
 * never resolves or downloads it. Retrieval security remains a provider
 * responsibility.
 */
export function isApprovedSpeakingAudioUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > SPEAKING_AUDIO_URL_MAX_LENGTH ||
    value.trim() !== value ||
    /\s/.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === SPEAKING_AUDIO_URL_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

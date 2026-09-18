export interface SpeakingAudioStoragePort {
  getReadUrl(objectKey: string): Promise<string>;
}

export const SPEAKING_AUDIO_STORAGE = Symbol('SPEAKING_AUDIO_STORAGE');

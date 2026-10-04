export const SPEAKING_AUDIO_CONTENT_TYPES = [
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
] as const;

export type SpeakingAudioContentType =
  (typeof SPEAKING_AUDIO_CONTENT_TYPES)[number];

export const SPEAKING_AUDIO_MIN_BYTES = 100;
export const SPEAKING_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const SPEAKING_AUDIO_UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const SPEAKING_AUDIO_UPLOAD_INTENT_TTL_MS = 60 * 60 * 1000;
export const SPEAKING_AUDIO_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export const SPEAKING_AUDIO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SPEAKING_AUDIO_OBJECT_PREFIX = 'orgs/';
export const SPEAKING_AUDIO_BUCKETS = {
  production: 'aihub-speaking-recordings',
  sandbox: 'aihub-sandbox-speaking-recordings',
} as const;

export type SpeakingAudioEnvironment = 'production' | 'sandbox';

export interface SpeakingAudioUploadIntent {
  readonly assetId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: SpeakingAudioEnvironment;
  readonly objectKey: string;
  readonly contentType: SpeakingAudioContentType;
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: 'open' | 'rejected';
}

export interface SpeakingAudioAsset {
  readonly assetId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: SpeakingAudioEnvironment;
  readonly objectKey: string;
  readonly contentType: SpeakingAudioContentType;
  readonly byteSize: number;
  readonly acceptedAt: Date;
  readonly retentionExpiresAt: Date;
}

const ASSET_ID_PATTERN = /^aud_[0-9A-HJKMNP-TV-Z]{26}$/;
const OBJECT_KEY_PATTERN =
  /^orgs\/[A-Za-z0-9_-]+\/speaking\/aud_[0-9A-HJKMNP-TV-Z]{26}\/original$/;

export function isSpeakingAudioContentType(
  value: string | undefined,
): value is SpeakingAudioContentType {
  return SPEAKING_AUDIO_CONTENT_TYPES.some(
    (contentType) => contentType === value,
  );
}

export function isSpeakingAudioAssetId(value: string): boolean {
  return ASSET_ID_PATTERN.test(value);
}

export function isSpeakingAudioObjectKey(value: string): boolean {
  return OBJECT_KEY_PATTERN.test(value);
}

export function speakingAudioObjectKey(
  organizationId: string,
  assetId: string,
): string {
  return `${SPEAKING_AUDIO_OBJECT_PREFIX}${organizationId}/speaking/${assetId}/original`;
}

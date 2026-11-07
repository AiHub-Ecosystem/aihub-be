export const SPEAKING_AUDIO_URL_MAX_LENGTH = 2_048;
export const SPEAKING_AUDIO_URL_HOST = 's3.wispace.app';

export type SpeakingAudioUrlRejectionReason =
  | 'malformed'
  | 'traversal'
  | 'foreign_tenant'
  | 'unapproved_bucket';

export type SpeakingAudioUrlPolicyResult =
  | { readonly approved: true }
  | {
      readonly approved: false;
      readonly reason: SpeakingAudioUrlRejectionReason;
    };

export interface SpeakingAudioUrlPolicyOptions {
  readonly organizationId: string;
  readonly audioAssetBucket: string | undefined;
  readonly sampleBucket: string;
}

const ASSET_KEY =
  /^orgs\/([A-Za-z0-9_-]+)\/speaking\/aud_[0-9A-HJKMNP-TV-Z]{26}\/original$/;
const CATALOG_SAMPLE_KEY = /^speaking-samples\/.+$/;
const PUBLIC_SAMPLE_PATH =
  '/ielts-task1/speaking-answers/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm';

function rejected(
  reason: SpeakingAudioUrlRejectionReason,
): SpeakingAudioUrlPolicyResult {
  return { approved: false, reason };
}

/** Checks the raw path before URL normalization, then the fixed host and bucket/key policy. */
export function isApprovedSpeakingAudioUrl(
  value: string,
  options: SpeakingAudioUrlPolicyOptions,
): SpeakingAudioUrlPolicyResult {
  if (
    value.length === 0 ||
    value.length > SPEAKING_AUDIO_URL_MAX_LENGTH ||
    value.trim() !== value ||
    /\s/.test(value)
  ) {
    return rejected('malformed');
  }

  const raw = /^https:\/\/[^/?#]*(?<path>\/[^?#]*)?(?:\?[^#]*)?$/i.exec(value);
  if (raw === null) return rejected('malformed');
  const rawPath = raw.groups?.path ?? '';
  if (
    /[%\\]/.test(rawPath) ||
    rawPath.includes('//') ||
    rawPath.split('/').some((segment) => segment === '.' || segment === '..') ||
    rawPath.endsWith('/')
  ) {
    return rejected('traversal');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return rejected('malformed');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== SPEAKING_AUDIO_URL_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return rejected('malformed');
  }

  const path = rawPath.slice(1);
  if (path === PUBLIC_SAMPLE_PATH.slice(1)) return { approved: true };

  const [bucket, ...keySegments] = path.split('/');
  const key = keySegments.join('/');
  if (bucket === options.sampleBucket && CATALOG_SAMPLE_KEY.test(key)) {
    return { approved: true };
  }
  if (bucket === options.audioAssetBucket) {
    const assetKey = ASSET_KEY.exec(key);
    if (assetKey?.[1] === options.organizationId) return { approved: true };
    if (assetKey !== null && assetKey[1] !== options.organizationId) {
      return rejected('foreign_tenant');
    }
  }
  return rejected('unapproved_bucket');
}

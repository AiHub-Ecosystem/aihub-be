import { AppError } from '@/common/errors/app-error';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';

/**
 * Organization-wide ceilings on Speaking Audio upload intents (#374). The
 * per-key rate limit bounds one API key; these bound the Organization however
 * many keys it holds, because a full SeaweedFS disk also takes down `aihub-db`
 * and every other project on the shared VPS.
 *
 * The per-intent ceiling is 25 MiB, so eight open intents bound outstanding
 * upload bytes to 200 MiB per Organization at once. Recording a full IELTS
 * answer needs one; the headroom covers a client that abandons an upload and
 * starts again.
 *
 * ponytail: fixed counts, not configuration. Make them settings only if a real
 * customer is refused; every value here is a policy, and policy lives beside
 * the use case.
 */
export const SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX = 8;

/** How many intents one Organization may create in a rolling window. */
export const SPEAKING_AUDIO_ORG_INTENT_ISSUANCE_MAX = 60;

/**
 * Stored Audio bytes one Organization may hold at once, counting completed
 * assets and the uploads an open intent may still turn into one. 5 GiB is far
 * above a real Organization's monthly recordings and far below the shared
 * disk, so it only ever refuses an abusive Organization.
 */
export const SPEAKING_AUDIO_ORG_STORED_BYTES_MAX = 5 * 1024 * 1024 * 1024;

/**
 * The window the issuance ceiling counts over. It matches the intent lifetime:
 * an intent older than this has expired and its object is being swept, so it
 * can no longer be used.
 */
export const SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS = 60 * 60 * 1000;

/** What an Organization currently holds, as the repository counts it. */
export interface SpeakingAudioOrganizationHolding {
  /** Intents still open and unexpired at the moment of the count. */
  readonly openIntents: number;
  /** Intents created in the rolling issuance window. */
  readonly issuedInWindow: number;
  /** Bytes of completed assets plus the bytes open intents may still store. */
  readonly storedBytes: number;
}

export type SpeakingAudioCeilingDecision =
  | { readonly kind: 'within' }
  | { readonly kind: 'refused'; readonly refusal: AppError };

function tooManyOpenIntents(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message:
      'Speaking audio upload limit reached; complete or abandon an open upload first',
    retryable: true,
    retryAfterMs: outageRetryAfterMs(),
  });
}

function tooManyIssuedIntents(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Speaking audio upload limit reached; retry later',
    retryable: true,
    retryAfterMs: SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS,
  });
}

function storageCeilingExceeded(): AppError {
  return new AppError({
    code: 'QUOTA_EXCEEDED',
    message: 'Speaking audio storage limit reached for this Organization',
    retryable: false,
  });
}

/**
 * Decides whether one more intent of `byteSize` fits the Organization's
 * ceilings. Pure: the repository counts the holding and calls this under its
 * advisory lock, so the decision is testable without a database.
 */
export function decideSpeakingAudioCeiling(
  holding: SpeakingAudioOrganizationHolding,
  byteSize: number,
): SpeakingAudioCeilingDecision {
  if (holding.openIntents >= SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX) {
    return { kind: 'refused', refusal: tooManyOpenIntents() };
  }
  if (holding.issuedInWindow >= SPEAKING_AUDIO_ORG_INTENT_ISSUANCE_MAX) {
    return { kind: 'refused', refusal: tooManyIssuedIntents() };
  }
  if (holding.storedBytes + byteSize > SPEAKING_AUDIO_ORG_STORED_BYTES_MAX) {
    return { kind: 'refused', refusal: storageCeilingExceeded() };
  }
  return { kind: 'within' };
}

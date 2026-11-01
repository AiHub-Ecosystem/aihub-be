import { AppError } from '@/common/errors/app-error';

import type {
  SpeakingV2ResultKind,
  SpeakingV2ResultOwner,
  SpeakingV2ResultOwnershipPort,
} from './speaking-v2-result-ownership.port';

/**
 * Refuses a request that names a Speaking result the caller has not recorded
 * (ADR-0138 decision 4). One missing id fails the whole request, and the error
 * does not say whether the id is unknown or belongs to someone else.
 */
export async function requireOwnedSpeakingResults(
  ownership: SpeakingV2ResultOwnershipPort,
  owner: SpeakingV2ResultOwner,
  kind: SpeakingV2ResultKind,
  ids: readonly string[],
): Promise<void> {
  const owned = new Set(await ownership.findOwnedIds(owner, kind, ids));
  if (ids.some((id) => !owned.has(id))) {
    throw new AppError({
      code: 'NOT_FOUND',
      message: 'Speaking result not found',
      retryable: false,
    });
  }
}

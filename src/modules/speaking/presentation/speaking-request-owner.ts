import { userIdentityRequired } from '@/common/errors/user-identity-required';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import type { SpeakingGradingJobOwner } from '@/modules/speaking/application/grading-jobs/speaking-grading-job';
import { speakingAudioEnvironment } from '@/modules/speaking/domain/speaking-audio-asset';

/** Who an authenticated Speaking request acts for: Organization, End User and environment. */
export function speakingRequestOwner(
  request: AuthenticatedRequest,
): SpeakingGradingJobOwner {
  const authenticated = getAuthenticatedApiKey(request);
  const identity = request.aihubIdentity;
  if (identity === undefined) {
    throw userIdentityRequired();
  }
  return {
    organizationId: authenticated.organizationId,
    endUserId: identity.userId,
    environment: speakingAudioEnvironment(authenticated.environment),
  };
}

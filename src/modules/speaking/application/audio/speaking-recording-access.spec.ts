import { AppError } from '@/common/errors/app-error';
import type {
  SpeakingAudioUploadLookup,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import type {
  SpeakingAudioAsset,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';
import { SpeakingRecordingAccess } from './speaking-recording-access';

const NOW = new Date('2026-11-17T00:00:00.000Z');
const OWNER: SpeakingAudioUploadOwner = {
  assetId: 'aud_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  organizationId: 'org_a',
  endUserId: 'user_a',
  environment: 'production',
};
const ASSET: SpeakingAudioAsset = {
  ...OWNER,
  objectKey: `orgs/org_a/speaking/${OWNER.assetId}/original`,
  contentType: 'audio/wav',
  byteSize: 200,
  acceptedAt: new Date(NOW.getTime() - 1_000),
  retentionExpiresAt: new Date(NOW.getTime() + 1_000),
};

function intent(status: 'open' | 'rejected'): SpeakingAudioUploadIntent {
  return {
    ...OWNER,
    objectKey: ASSET.objectKey,
    contentType: 'audio/wav',
    byteSize: 200,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 1_000),
    status,
  };
}

/** Stores one record and, like the real repository, answers it only to its exact owner. */
function uploadsHolding(
  lookup: SpeakingAudioUploadLookup,
): Pick<SpeakingAudioUploadRepositoryPort, 'findUpload'> {
  const held =
    lookup.kind === 'asset'
      ? lookup.asset
      : lookup.kind === 'intent'
        ? lookup.intent
        : undefined;
  return {
    async findUpload(owner) {
      return held !== undefined &&
        held.assetId === owner.assetId &&
        held.organizationId === owner.organizationId &&
        held.endUserId === owner.endUserId &&
        held.environment === owner.environment
        ? lookup
        : { kind: 'missing' };
    },
  };
}

function accessTo(lookup: SpeakingAudioUploadLookup): SpeakingRecordingAccess {
  return new SpeakingRecordingAccess(uploadsHolding(lookup), () => NOW);
}

async function refusal(
  access: SpeakingRecordingAccess,
  owner: SpeakingAudioUploadOwner,
): Promise<AppError> {
  const error: unknown = await access.assertLive(owner).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof AppError)) throw new Error('expected a refusal');
  return error;
}

describe('SpeakingRecordingAccess', () => {
  it.each([
    ['production', OWNER],
    [
      'sandbox',
      { ...OWNER, environment: 'sandbox' } satisfies SpeakingAudioUploadOwner,
    ],
  ] as const)(
    'accepts an accepted asset inside retention for its own %s owner',
    async (_name, owner) => {
      const access = accessTo({
        kind: 'asset',
        asset: { ...ASSET, environment: owner.environment },
      });

      await expect(access.assertLive(owner)).resolves.toBeUndefined();
    },
  );

  it.each([
    ['another End User', { ...OWNER, endUserId: 'user_b' }],
    ['another Organization', { ...OWNER, organizationId: 'org_b' }],
    ['another environment', { ...OWNER, environment: 'sandbox' }],
    [
      'another asset id',
      { ...OWNER, assetId: 'aud_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    ],
  ] as const)(
    'refuses an asset owned by %s as unknown',
    async (_name, owner) => {
      const error = await refusal(
        accessTo({ kind: 'asset', asset: ASSET }),
        owner,
      );

      expect(error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Speaking audio asset not found',
        retryable: false,
      });
    },
  );

  it.each([
    [
      'an upload that is still open',
      { kind: 'intent', intent: intent('open') },
    ],
    [
      'an upload that was rejected',
      { kind: 'intent', intent: intent('rejected') },
    ],
    [
      'an asset past its retention deadline',
      {
        kind: 'asset',
        asset: { ...ASSET, retentionExpiresAt: new Date(NOW.getTime() - 1) },
      },
    ],
    [
      'an asset at its retention deadline',
      {
        kind: 'asset',
        asset: { ...ASSET, retentionExpiresAt: NOW },
      },
    ],
    ['an absent asset', { kind: 'missing' }],
  ] as const)(
    'refuses %s with the answer of an unknown asset',
    async (_name, lookup) => {
      const error = await refusal(accessTo(lookup), OWNER);

      expect(error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Speaking audio asset not found',
        retryable: false,
      });
    },
  );
});

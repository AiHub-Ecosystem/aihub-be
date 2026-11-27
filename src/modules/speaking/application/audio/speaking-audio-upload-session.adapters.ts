import { randomUUID } from 'node:crypto';

import type { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { storageUnavailable } from '@/common/errors/upload-errors';
import { recordRejected } from '@/common/observability/metrics/rejected-metric';
import { SPEAKING_AUDIO_COMPLETION_DEADLINE_MS } from '@/modules/speaking/application/audio/speaking-audio-completion-timeouts';
import {
  SPEAKING_AUDIO_RETENTION_MS,
  type SpeakingAudioAsset,
  type SpeakingAudioContentType,
  type SpeakingAudioEnvironment,
  type SpeakingAudioUploadIntent,
  isSpeakingAudioContentType,
  speakingAudioStagingObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import {
  type UploadSessionCleanupCandidate as CleanupBase,
  type UploadSessionIntent as IntentBase,
  type UploadSessionLookup as LookupBase,
  type UploadSessionOwner as OwnerBase,
  type PublishedUploadSession as PubBase,
  type UploadSessionRepositoryPort,
} from '@/modules/uploads/public';

type CorePublished = PubBase<
  SpeakingAudioContentType,
  SpeakingAudioEnvironment
>;
type CoreCandidate = CleanupBase<SpeakingAudioEnvironment>;
type CoreIntent = IntentBase<
  SpeakingAudioContentType,
  SpeakingAudioEnvironment
>;
type CoreLookup = LookupBase<
  SpeakingAudioContentType,
  SpeakingAudioEnvironment
>;
type CoreOwner = OwnerBase<SpeakingAudioEnvironment>;
import { decideSpeakingAudioCeiling } from './speaking-audio-org-ceiling.policy';
import type {
  SpeakingAudioCleanupCandidate,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from './speaking-audio-upload.port';

function speakingOwner(owner: CoreOwner): SpeakingAudioUploadOwner {
  if (
    owner.organizationId === undefined ||
    (owner.environment !== 'production' && owner.environment !== 'sandbox')
  ) {
    throw storageUnavailable(
      'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
      'Speaking audio storage is unavailable',
    );
  }
  return {
    assetId: owner.assetId,
    organizationId: owner.organizationId,
    endUserId: owner.endUserId,
    environment: owner.environment,
  };
}

function speakingIntent(intent: CoreIntent): SpeakingAudioUploadIntent {
  const owner = speakingOwner(intent);
  return {
    ...owner,
    objectKey: intent.publishedKey,
    contentType: intent.contentType,
    byteSize: intent.byteSize,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    status: intent.status === 'rejected' ? 'rejected' : 'open',
  };
}

function coreIntent(intent: SpeakingAudioUploadIntent): CoreIntent {
  return {
    assetId: intent.assetId,
    organizationId: intent.organizationId,
    endUserId: intent.endUserId,
    environment: intent.environment,
    stagingKey: speakingAudioStagingObjectKey(
      intent.organizationId,
      intent.assetId,
    ),
    publishedKey: intent.objectKey,
    contentType: intent.contentType,
    byteSize: intent.byteSize,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    status: intent.status === 'rejected' ? 'rejected' : 'open',
  };
}

function coreAsset(asset: SpeakingAudioAsset, created: boolean): CorePublished {
  return {
    assetId: asset.assetId,
    organizationId: asset.organizationId,
    endUserId: asset.endUserId,
    environment: asset.environment,
    stagingKey: speakingAudioStagingObjectKey(
      asset.organizationId,
      asset.assetId,
    ),
    publishedKey: asset.objectKey,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    createdAt: asset.acceptedAt,
    expiresAt: asset.retentionExpiresAt,
    status: 'published',
    publishedAt: asset.acceptedAt,
    retentionExpiresAt: asset.retentionExpiresAt,
    imageUrl: '',
    created,
  };
}

export class SpeakingAudioCoreRepositoryAdapter
  implements
    UploadSessionRepositoryPort<
      SpeakingAudioContentType,
      SpeakingAudioEnvironment
    >
{
  // ponytail: the bridge completes its legacy transaction on the starting instance until activation and drain (#1732).
  private readonly pending = new Map<
    string,
    {
      readonly intent: SpeakingAudioUploadIntent;
      readonly decide: (
        result:
          | { readonly kind: 'accepted'; readonly asset: SpeakingAudioAsset }
          | { readonly kind: 'refused'; readonly refusal: AppError },
      ) => void;
      readonly result: Promise<
        Awaited<ReturnType<SpeakingAudioUploadRepositoryPort['completeIntent']>>
      >;
    }
  >();

  constructor(
    private readonly repository: SpeakingAudioUploadRepositoryPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createIntent(intent: CoreIntent): Promise<boolean> {
    const decision = await this.repository.createIntentWithinCeiling({
      intent: speakingIntent(intent),
      decide: (holding) => decideSpeakingAudioCeiling(holding, intent.byteSize),
    });
    if (decision.kind === 'refused') {
      recordRejected(
        decision.refusal.code === 'QUOTA_EXCEEDED' ? 'quota' : 'rate_limit',
      );
      throw decision.refusal;
    }
    return true;
  }

  async findUpload(owner: CoreOwner): Promise<CoreLookup> {
    const found = await this.repository.findUpload(speakingOwner(owner));
    if (found.kind === 'missing') return { kind: 'missing' };
    if (found.kind === 'asset')
      return { kind: 'asset', asset: coreAsset(found.asset, false) };
    return { kind: 'intent', intent: coreIntent(found.intent) };
  }

  async rejectIntent(
    owner: CoreOwner,
    _now: Date,
    cleaned = false,
  ): Promise<void> {
    const speaking = speakingOwner(owner);
    const found = await this.repository.findUpload(speaking);
    if (found.kind === 'intent' && found.intent.status === 'open') {
      await this.repository.completeIntent({
        owner: speaking,
        now: this.now,
        prepare: async () => ({ kind: 'refused', refusal: invalidRequest() }),
      });
    }
    if (cleaned) await this.repository.removeRejectedIntent(speaking);
  }

  async claimRefusal(
    owner: CoreOwner,
    reservationId?: string,
  ): Promise<boolean | undefined> {
    return this.repository.claimRefusal?.(speakingOwner(owner), reservationId);
  }

  async beginPublication(input: {
    readonly owner: CoreOwner;
    readonly now: Date;
  }): Promise<
    | 'started'
    | {
        readonly kind: 'started';
        readonly reservationId: string;
        readonly publishedKey: string;
      }
    | 'published'
    | 'in_progress'
    | 'missing'
  > {
    const owner = speakingOwner(input.owner);
    while (true) {
      const result =
        (await this.repository.beginPublication?.({
          owner,
          now: input.now,
          reservationTtlMs: SPEAKING_AUDIO_COMPLETION_DEADLINE_MS,
        })) ?? 'disabled';
      if (result === 'disabled') {
        const legacy = await this.beginLegacyPublication(owner, input.now);
        if (legacy === 'retry') continue;
        return legacy;
      }
      if (typeof result === 'object') {
        return {
          kind: 'started',
          reservationId: result.reservationId,
          publishedKey: result.objectKey,
        };
      }
      return result;
    }
  }

  private async beginLegacyPublication(
    owner: SpeakingAudioUploadOwner,
    now: Date,
  ): Promise<'started' | 'published' | 'missing' | 'retry'> {
    const found = await this.repository.findUpload(owner);
    if (found.kind === 'asset') return 'published';
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt.getTime() <= now.getTime()
    ) {
      return 'missing';
    }
    let decide!: (
      result:
        | { readonly kind: 'accepted'; readonly asset: SpeakingAudioAsset }
        | { readonly kind: 'refused'; readonly refusal: AppError },
    ) => void;
    const gate = new Promise<
      | { readonly kind: 'accepted'; readonly asset: SpeakingAudioAsset }
      | { readonly kind: 'refused'; readonly refusal: AppError }
    >((resolve) => {
      decide = resolve;
    });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const result = this.repository.completeIntent({
      owner,
      now: () => now,
      legacyPublication: true,
      prepare: async () => {
        announceStarted();
        return await gate;
      },
    });
    void result.catch(() => undefined);
    const outcome = await Promise.race([
      started.then(() => ({ kind: 'started' as const })),
      result.then((value) => ({ kind: 'settled' as const, value })),
    ]);
    if (outcome.kind === 'started') {
      this.pending.set(found.intent.assetId, {
        intent: found.intent,
        decide,
        result,
      });
      return 'started';
    }
    if (outcome.value.kind === 'protocol_enabled') return 'retry';
    if (
      outcome.value.kind === 'already_completed' ||
      outcome.value.kind === 'created'
    ) {
      return 'published';
    }
    if (outcome.value.kind === 'refused') throw outcome.value.refusal;
    return 'missing';
  }

  async markPublished(input: {
    readonly owner: CoreOwner;
    readonly now: Date;
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
    readonly reservationId?: string;
  }): Promise<CorePublished | 'revoked' | undefined> {
    if (input.reservationId !== undefined) {
      if (this.repository.finalizePublication === undefined) return undefined;
      const result = await this.repository.finalizePublication({
        owner: speakingOwner(input.owner),
        reservationId: input.reservationId,
        acceptedAt: input.now,
        retentionExpiresAt: new Date(
          input.now.getTime() + SPEAKING_AUDIO_RETENTION_MS,
        ),
      });
      return result === undefined
        ? undefined
        : coreAsset(result.asset, result.created);
    }
    const pending = this.pending.get(input.owner.assetId);
    if (pending === undefined) return undefined;
    const { intent } = pending;
    pending.decide({
      kind: 'accepted',
      asset: {
        assetId: intent.assetId,
        organizationId: intent.organizationId,
        endUserId: intent.endUserId,
        environment: intent.environment,
        objectKey: intent.objectKey,
        contentType: intent.contentType,
        byteSize: intent.byteSize,
        acceptedAt: input.now,
        retentionExpiresAt: new Date(
          input.now.getTime() + SPEAKING_AUDIO_RETENTION_MS,
        ),
      },
    });
    const result = await pending.result;
    this.pending.delete(input.owner.assetId);
    if (result.kind === 'created') return coreAsset(result.asset, true);
    if (result.kind === 'already_completed')
      return coreAsset(result.asset, false);
    if (result.kind === 'refused') throw result.refusal;
    return undefined;
  }

  async releasePublication(
    owner: CoreOwner,
    _publicationStartedAt: Date,
    reservationId?: string,
  ): Promise<void> {
    if (reservationId !== undefined) {
      if (this.repository.releasePublication !== undefined) {
        await this.repository.releasePublication({
          owner: speakingOwner(owner),
          reservationId,
        });
      }
      return;
    }
    const pending = this.pending.get(owner.assetId);
    if (pending !== undefined) {
      pending.decide({ kind: 'refused', refusal: invalidRequest() });
      await pending.result;
      this.pending.delete(owner.assetId);
    }
  }

  async cleanupCandidates(input: {
    readonly now: Date;
    readonly orphanBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly CoreCandidate[]> {
    const rows = await (this.repository.listDurableCleanupCandidates ===
    undefined
      ? this.repository.listCleanupCandidates({
          expiredBefore: input.orphanBefore,
          limit: input.limit,
          ...(input.after === undefined ? {} : { after: input.after }),
        })
      : this.repository.listDurableCleanupCandidates({
          expiredBefore: input.orphanBefore,
          limit: input.limit,
          ...(input.after === undefined ? {} : { after: input.after }),
        }));
    return rows.map((row) => ({
      kind: 'kind' in row ? row.kind : 'intent',
      assetId: row.assetId,
      candidateId: 'candidateId' in row ? row.candidateId : row.assetId,
      organizationId: row.organizationId,
      endUserId: row.endUserId,
      environment: row.environment,
      ...(('kind' in row ? row.kind : 'intent') === 'intent'
        ? {
            stagingKey: speakingAudioStagingObjectKey(
              row.organizationId,
              row.assetId,
            ),
          }
        : {}),
      publishedKey: row.objectKey,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      status: row.status,
      ...(row.contentType === undefined
        ? {}
        : { contentType: row.contentType }),
      ...(row.byteSize === undefined ? {} : { byteSize: row.byteSize }),
      orphanBefore: input.orphanBefore,
      ...(!('reservationId' in row) || row.reservationId === undefined
        ? {}
        : { reservationId: row.reservationId }),
      ...(!('lastCleanedAt' in row) || row.lastCleanedAt === undefined
        ? {}
        : { lastCleanedAt: row.lastCleanedAt }),
    }));
  }

  async claimCleanupCandidate(
    candidate: CoreCandidate,
    _now: Date,
  ): Promise<CoreCandidate | undefined> {
    const row = speakingCleanupCandidate(candidate);
    if (row === undefined || candidate.orphanBefore === undefined)
      return undefined;
    if (this.repository.listDurableCleanupCandidates === undefined) {
      return candidate;
    }
    if (this.repository.claimDurableCleanupCandidate === undefined)
      return undefined;
    const claimId = randomUUID();
    const claimed = await this.repository.claimDurableCleanupCandidate({
      candidate: row,
      orphanBefore: candidate.orphanBefore,
      claimId,
      leaseMs: 60_000,
    });
    return claimed ? { ...candidate, claimId } : undefined;
  }

  async removeCleanupCandidate(candidate: CoreCandidate): Promise<boolean> {
    const row = speakingCleanupCandidate(candidate);
    if (row === undefined || candidate.orphanBefore === undefined) {
      return false;
    }
    if (this.repository.removeDurableCleanupCandidate !== undefined) {
      if (candidate.claimId === undefined) return false;
      return this.repository.removeDurableCleanupCandidate({
        candidate: row,
        expiredBefore: candidate.orphanBefore,
        claimId: candidate.claimId,
      });
    }
    const intent = speakingCleanupIntent(candidate);
    return intent === undefined
      ? false
      : this.repository.removeCleanupCandidate({
          intent,
          expiredBefore: candidate.orphanBefore,
        });
  }
}

function speakingCleanupIntent(
  candidate: CoreCandidate,
): SpeakingAudioUploadIntent | undefined {
  if (
    candidate.kind !== 'intent' ||
    candidate.organizationId === undefined ||
    candidate.endUserId === undefined ||
    candidate.contentType === undefined ||
    !isSpeakingAudioContentType(candidate.contentType) ||
    candidate.byteSize === undefined ||
    candidate.expiresAt === undefined ||
    (candidate.status !== 'open' && candidate.status !== 'rejected')
  ) {
    return undefined;
  }
  return {
    assetId: candidate.assetId,
    organizationId: candidate.organizationId,
    endUserId: candidate.endUserId,
    environment: candidate.environment,
    objectKey: candidate.publishedKey,
    contentType: candidate.contentType,
    byteSize: candidate.byteSize,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
    status: candidate.status,
  };
}

function speakingCleanupCandidate(
  candidate: CoreCandidate,
): SpeakingAudioCleanupCandidate | undefined {
  if (
    (candidate.kind !== 'intent' && candidate.kind !== 'reservation') ||
    candidate.organizationId === undefined ||
    candidate.endUserId === undefined ||
    candidate.status === undefined ||
    candidate.expiresAt === undefined ||
    (candidate.kind === 'reservation' && candidate.reservationId === undefined)
  ) {
    return undefined;
  }
  return {
    kind: candidate.kind,
    candidateId: candidate.candidateId ?? candidate.assetId,
    assetId: candidate.assetId,
    organizationId: candidate.organizationId,
    endUserId: candidate.endUserId,
    environment: candidate.environment,
    objectKey: candidate.publishedKey,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
    status: candidate.status,
    ...(candidate.reservationId === undefined
      ? {}
      : { reservationId: candidate.reservationId }),
    ...(candidate.lastCleanedAt === undefined
      ? {}
      : { lastCleanedAt: candidate.lastCleanedAt }),
  };
}

export { SpeakingAudioCoreStorageAdapter } from './speaking-audio-upload-storage-adapter';

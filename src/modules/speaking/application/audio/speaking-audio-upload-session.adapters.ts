import type { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { storageUnavailable } from '@/common/errors/upload-errors';
import { recordRejected } from '@/common/observability/metrics/rejected-metric';
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
  type UploadSessionStoragePort,
  UploadSessionVerificationRefusal,
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
import {
  speakingFinalRefusal,
  speakingStagingRefusal,
} from './speaking-audio-upload-session.refusal';
import type {
  SpeakingAudioAssetStoragePort,
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
  private readonly orphanBefore = new Map<string, Date>();
  private readonly cleanupRows = new Map<string, SpeakingAudioUploadIntent>();

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
    if (found.kind === 'intent') {
      await this.repository.completeIntent({
        owner: speaking,
        now: this.now,
        prepare: async () => ({ kind: 'refused', refusal: invalidRequest() }),
      });
    }
    if (cleaned) await this.repository.removeRejectedIntent(speaking);
  }

  async beginPublication(input: {
    readonly owner: CoreOwner;
    readonly now: Date;
  }): Promise<'started' | 'published' | 'limited' | 'in_progress' | 'missing'> {
    const found = await this.repository.findUpload(speakingOwner(input.owner));
    if (found.kind === 'asset') return 'published';
    if (
      found.kind !== 'intent' ||
      found.intent.status !== 'open' ||
      found.intent.expiresAt.getTime() <= input.now.getTime()
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
    const result = this.repository.completeIntent({
      owner: speakingOwner(input.owner),
      now: () => input.now,
      prepare: async () => await gate,
    });
    this.pending.set(found.intent.assetId, {
      intent: found.intent,
      decide,
      result,
    });
    return 'started';
  }

  async markPublished(input: {
    readonly owner: CoreOwner;
    readonly now: Date;
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
  }): Promise<CorePublished | 'revoked' | undefined> {
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

  async releasePublication(owner: CoreOwner): Promise<void> {
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
    const rows = await this.repository.listCleanupCandidates({
      expiredBefore: input.orphanBefore,
      limit: input.limit,
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    return rows.map((row) => {
      this.orphanBefore.set(row.assetId, input.orphanBefore);
      this.cleanupRows.set(row.assetId, row);
      return {
        kind: 'intent',
        assetId: row.assetId,
        environment: row.environment,
        stagingKey: speakingAudioStagingObjectKey(
          row.organizationId,
          row.assetId,
        ),
        publishedKey: row.objectKey,
        createdAt: row.createdAt,
      };
    });
  }

  async removeCleanupCandidate(candidate: CoreCandidate): Promise<boolean> {
    const row = this.cleanupRows.get(candidate.assetId);
    if (row === undefined) return false;
    this.cleanupRows.delete(candidate.assetId);
    return this.repository.removeCleanupCandidate({
      intent: row,
      expiredBefore: this.orphanBefore.get(candidate.assetId) ?? new Date(0),
    });
  }
}

export class SpeakingAudioCoreStorageAdapter
  implements
    UploadSessionStoragePort<SpeakingAudioContentType, SpeakingAudioEnvironment>
{
  constructor(private readonly storage: SpeakingAudioAssetStoragePort) {}

  async createUploadUrl(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly stagingKey: string;
    readonly contentType: SpeakingAudioContentType;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }> {
    const signed = await this.storage.createUploadUrl({
      environment: input.environment,
      objectKey: input.stagingKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
    });
    return { ...signed, fields: {} };
  }

  async inspectObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly stagingKey: string;
      readonly contentType?: SpeakingAudioContentType;
      readonly byteSize: number;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly contentType: SpeakingAudioContentType | undefined;
        readonly byteSize: number | undefined;
        readonly bytes: Uint8Array;
      }
    | undefined
  > {
    const described = await this.storage.describeObject(
      {
        environment: input.environment,
        objectKey: input.stagingKey,
      },
      signal,
    );
    if (described === undefined) return undefined;
    const refusal = speakingStagingRefusal(described, {
      contentType: input.contentType ?? '',
      byteSize: input.byteSize,
    });
    if (refusal !== undefined)
      throw new UploadSessionVerificationRefusal(refusal);
    return {
      contentType: isSpeakingAudioContentType(described.contentType)
        ? described.contentType
        : undefined,
      byteSize: described.byteSize,
      bytes: new Uint8Array(),
    };
  }

  async publishObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: SpeakingAudioContentType;
      readonly bytes: Uint8Array;
      readonly byteSize?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const environment = input.environment;
    await this.storage.copyObject(
      {
        environment,
        sourceObjectKey: input.stagingKey,
        destinationObjectKey: input.publishedKey,
      },
      signal,
    );
    const final = await this.storage.describeObject(
      { environment, objectKey: input.publishedKey },
      signal,
    );
    const refusal = speakingFinalRefusal(
      {
        contentType: final?.contentType,
        byteSize: final?.byteSize,
      },
      {
        contentType: input.contentType,
        byteSize: input.byteSize ?? 0,
      },
    );
    if (refusal !== undefined)
      throw new UploadSessionVerificationRefusal(refusal);
  }

  async deleteRefusedObject(
    intent: CoreIntent,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return true;
    try {
      const environment = speakingOwner(intent).environment;
      await this.storage.deleteObject(
        { environment, objectKey: intent.publishedKey },
        signal,
      );
      await this.storage.deleteObject(
        { environment, objectKey: intent.stagingKey },
        signal,
      );
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(): string {
    return '';
  }

  async deleteStagingObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly stagingKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal === undefined)
      await this.storage.deleteObject({
        environment: input.environment,
        objectKey: input.stagingKey,
      });
    else
      await this.storage.deleteObject(
        {
          environment: input.environment,
          objectKey: input.stagingKey,
        },
        signal,
      );
  }

  async deletePublishedObject(
    input: {
      readonly environment: SpeakingAudioEnvironment;
      readonly publishedKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal === undefined)
      await this.storage.deleteObject({
        environment: input.environment,
        objectKey: input.publishedKey,
      });
    else
      await this.storage.deleteObject(
        {
          environment: input.environment,
          objectKey: input.publishedKey,
        },
        signal,
      );
  }
}

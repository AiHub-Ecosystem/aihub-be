import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { uploadNotFound } from '@/common/errors/upload-errors';
import {
  AVATAR_COMPLETION_WINDOW_MS,
  AVATAR_MAX_BYTES,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type Avatar,
  type AvatarContentType,
  avatarObjectKey,
  isAvatarContentType,
} from '@/modules/avatar/domain/avatar';
import type {
  UploadSessionCleanupCandidate as CleanupBase,
  UploadSessionIntent as IntentBase,
  UploadSessionLookup as LookupBase,
  UploadSessionOwner as OwnerBase,
  PublishedUploadSession as PubBase,
  UploadSessionRepositoryPort,
  UploadSessionStoragePort,
} from '@/modules/uploads/public';

type CorePublished = PubBase<AvatarContentType, 'production'>;
type CoreCandidate = CleanupBase<'production'>;
type CoreIntent = IntentBase<AvatarContentType, 'production'>;
type CoreLookup = LookupBase<AvatarContentType, 'production'>;
type CoreOwner = OwnerBase<'production'>;
import type {
  AvatarAuditEvent,
  AvatarRepositoryPort,
} from './avatar-repository.port';
import type { AvatarStoragePort } from './avatar-storage.port';
import {
  AVATAR_OPEN_UPLOAD_MAX,
  AVATAR_UPLOAD_ISSUANCE_MAX,
  AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
} from './avatar-upload.policy';

export function avatarChanged(): AppError {
  return new AppError({
    code: 'AVATAR_CHANGED',
    message: 'The Avatar was changed by another request',
    retryable: false,
  });
}

function storedTooLarge(): AppError {
  return new AppError({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Avatar image is larger than 2 MiB',
    retryable: false,
  });
}

function coreAsset(avatar: Avatar, created: boolean): CorePublished {
  return {
    assetId: avatar.assetId,
    endUserId: avatar.userId,
    environment: 'production',
    stagingKey: avatar.objectKey,
    publishedKey: avatar.objectKey,
    contentType: avatar.contentType,
    byteSize: avatar.byteSize,
    createdAt: avatar.acceptedAt,
    expiresAt: avatar.acceptedAt,
    status: 'published',
    publishedAt: avatar.acceptedAt,
    imageUrl: avatar.objectKey,
    created,
  };
}

function audit(
  action: AvatarAuditEvent['action'],
  assetId: string,
  requestId: string | undefined,
  occurredAt: Date,
): AvatarAuditEvent {
  return { action, assetId, requestId: requestId ?? '', occurredAt };
}

type Gate =
  | {
      readonly kind: 'accepted';
      readonly avatar: Avatar;
      readonly requestId: string | undefined;
    }
  | { readonly kind: 'refused'; readonly refusal: AppError };

type GateResult =
  | {
      readonly kind: 'recorded';
      readonly avatar: Avatar;
      readonly created: boolean;
    }
  | { readonly kind: 'rejected' };

export class AvatarCoreRepositoryAdapter
  implements UploadSessionRepositoryPort<AvatarContentType, 'production'>
{
  private readonly gates = new Map<
    string,
    { decide(result: Gate): void; result: Promise<GateResult> }
  >();

  constructor(
    private readonly repository: AvatarRepositoryPort,
    private readonly now: () => Date = () => new Date(),
    private readonly storage?: AvatarCoreStorageAdapter,
  ) {}

  async createIntent(
    intent: CoreIntent,
    rateWindowMs?: number,
  ): Promise<boolean> {
    return this.repository.grantUpload(
      {
        userId: intent.endUserId,
        assetId: intent.assetId,
        objectKey: intent.stagingKey,
        expiresAt: intent.expiresAt,
        createdAt: intent.createdAt,
      },
      {
        openLimit: AVATAR_OPEN_UPLOAD_MAX,
        issuanceLimit: AVATAR_UPLOAD_ISSUANCE_MAX,
        issuanceWindowMs: rateWindowMs ?? AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
      },
    );
  }

  async findUpload(owner: CoreOwner): Promise<CoreLookup> {
    const userId = owner.endUserId;
    const current = await this.repository.findByUser(userId);
    if (current?.assetId === owner.assetId) {
      return { kind: 'asset', asset: coreAsset(current, false) };
    }
    const grants = await this.repository.openUploadGrants(userId, this.now());
    const grant = grants.find((row) => row.assetId === owner.assetId);
    if (grant === undefined) {
      // The grant is rate-limit bookkeeping, not a completion precondition:
      // a direct caller may complete staged bytes it never requested a URL for.
      const now = this.now();
      return {
        kind: 'intent',
        intent: {
          assetId: owner.assetId,
          endUserId: userId,
          environment: 'production',
          stagingKey: avatarObjectKey(userId, owner.assetId),
          publishedKey: avatarObjectKey(userId, owner.assetId),
          contentType: 'image/jpeg',
          byteSize: 0,
          createdAt: now,
          expiresAt: new Date(now.getTime() + AVATAR_COMPLETION_WINDOW_MS),
          status: 'open',
        },
      };
    }
    return {
      kind: 'intent',
      intent: {
        assetId: grant.assetId,
        endUserId: userId,
        environment: 'production',
        stagingKey: grant.objectKey,
        publishedKey: avatarObjectKey(userId, grant.assetId),
        contentType: 'image/jpeg',
        byteSize: 0,
        createdAt: new Date(
          grant.expiresAt.getTime() - AVATAR_UPLOAD_URL_TTL_SECONDS * 1000,
        ),
        expiresAt: grant.expiresAt,
        status: 'open',
      },
    };
  }

  async rejectIntent(owner: CoreOwner): Promise<void> {
    await this.repository.consumeUploadGrant(owner.endUserId, owner.assetId);
  }

  async beginPublication(input: {
    readonly owner: CoreOwner;
    readonly now: Date;
  }): Promise<'started' | 'published' | 'limited' | 'in_progress' | 'missing'> {
    const found = await this.findUpload(input.owner);
    if (found.kind === 'asset') return 'published';
    if (found.kind !== 'intent') return 'missing';

    let decide!: (result: Gate) => void;
    const gate = new Promise<Gate>((resolve) => {
      decide = resolve;
    });
    const userId = input.owner.endUserId;
    const result = this.repository.withUserLock(userId, async (avatars) => {
      const prepared = await gate;
      if (prepared.kind === 'refused') return { kind: 'rejected' as const };
      const previous = await avatars.findByUser(userId);
      if (previous?.assetId === prepared.avatar.assetId) {
        return { kind: 'recorded' as const, avatar: previous, created: false };
      }
      if (previous === undefined) {
        const recorded = await avatars.record(
          prepared.avatar,
          audit(
            'avatar.set',
            prepared.avatar.assetId,
            prepared.requestId,
            input.now,
          ),
        );
        if (recorded.kind === 'exists') {
          const current = await avatars.findByUser(userId);
          if (current?.assetId !== prepared.avatar.assetId)
            throw avatarChanged();
          return {
            kind: 'recorded' as const,
            avatar: current ?? prepared.avatar,
            created: false,
          };
        }
        return {
          kind: 'recorded' as const,
          avatar: recorded.avatar,
          created: true,
        };
      }
      const replaced = await avatars.replace(
        previous.assetId,
        prepared.avatar,
        audit(
          'avatar.replaced',
          prepared.avatar.assetId,
          prepared.requestId,
          input.now,
        ),
      );
      if (!replaced) {
        const current = await avatars.findByUser(userId);
        if (current?.assetId !== prepared.avatar.assetId) throw avatarChanged();
        return {
          kind: 'recorded' as const,
          avatar: current ?? previous,
          created: false,
        };
      }
      return {
        kind: 'recorded' as const,
        avatar: prepared.avatar,
        created: true,
      };
    });
    this.gates.set(input.owner.assetId, { decide, result });
    return 'started';
  }

  async markPublished(input: {
    readonly owner: CoreOwner;
    readonly now: Date;
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
    readonly requestId?: string;
    readonly contentType?: AvatarContentType;
    readonly byteSize?: number;
  }): Promise<CorePublished | 'revoked' | undefined> {
    const gate = this.gates.get(input.owner.assetId);
    if (gate === undefined) return undefined;
    const objectKey = avatarObjectKey(
      input.owner.endUserId,
      input.owner.assetId,
    );
    const landed = this.storage?.publishedDescriptor(objectKey);
    // The core always supplies a content type; the placeholder matches the
    // one `findUpload` declares for an Avatar intent.
    const contentType =
      landed?.contentType ?? input.contentType ?? 'image/jpeg';
    const avatar: Avatar = {
      assetId: input.owner.assetId,
      userId: input.owner.endUserId,
      objectKey,
      contentType,
      byteSize: landed?.byteSize ?? input.byteSize ?? 0,
      acceptedAt: input.now,
    };
    gate.decide({ kind: 'accepted', avatar, requestId: input.requestId });
    const result = await gate.result;
    this.gates.delete(input.owner.assetId);
    await this.repository.consumeUploadGrant(
      input.owner.endUserId,
      input.owner.assetId,
    );
    if (result.kind === 'rejected') return undefined;
    return coreAsset(result.avatar, result.created);
  }

  async releasePublication(owner: CoreOwner): Promise<void> {
    const gate = this.gates.get(owner.assetId);
    if (gate === undefined) return;
    gate.decide({ kind: 'refused', refusal: invalidRequest() });
    await gate.result;
    this.gates.delete(owner.assetId);
  }

  async cleanupCandidates(): Promise<readonly CoreCandidate[]> {
    return [];
  }

  async removeCleanupCandidate(): Promise<boolean> {
    return true;
  }
}

export class AvatarCoreStorageAdapter
  implements UploadSessionStoragePort<AvatarContentType, 'production'>
{
  private readonly publishedDescriptors = new Map<
    string,
    { readonly contentType: AvatarContentType; readonly byteSize: number }
  >();

  constructor(
    private readonly storage: AvatarStoragePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  publishedDescriptor(
    publishedKey: string,
  ):
    | { readonly contentType: AvatarContentType; readonly byteSize: number }
    | undefined {
    return this.publishedDescriptors.get(publishedKey);
  }

  async createUploadUrl(input: {
    readonly environment: 'production';
    readonly stagingKey: string;
    readonly contentType: AvatarContentType;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }> {
    const signed = await this.storage.createUploadUrl({
      objectKey: input.stagingKey,
      contentType: input.contentType,
    });
    return { ...signed, fields: {} };
  }

  async inspectObject(
    input: {
      readonly environment: 'production';
      readonly stagingKey: string;
      readonly contentType?: AvatarContentType;
      readonly byteSize: number;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly contentType: AvatarContentType | undefined;
        readonly byteSize: number | undefined;
        readonly bytes: Uint8Array;
        readonly lastModified?: Date;
        readonly etag?: string;
      }
    | undefined
  > {
    // Storage inspection runs on the completion deadline, not the request
    // signal: a requester disconnect must not abort an in-flight re-encode.
    const processing =
      signal === undefined ? undefined : AbortSignal.any([signal]);
    const described = await this.storage.describeStagingObject(
      input.stagingKey,
      processing,
    );
    if (described === undefined) return undefined;
    const age =
      described.lastModified === undefined
        ? undefined
        : this.now().getTime() - described.lastModified.getTime();
    if (age === undefined || age > AVATAR_COMPLETION_WINDOW_MS) {
      await this.discardStaging(input.stagingKey, signal);
      return undefined;
    }
    const { contentType, byteSize } = described;
    if (byteSize !== undefined && byteSize > AVATAR_MAX_BYTES) {
      await this.discardStaging(input.stagingKey, signal);
      throw storedTooLarge();
    }
    if (
      !isAvatarContentType(contentType) ||
      byteSize === undefined ||
      byteSize < 1
    ) {
      await this.discardStaging(input.stagingKey, signal);
      throw invalidRequest();
    }
    const staged = await this.storage.readStagingObject(
      input.stagingKey,
      described.etag,
      processing,
    );
    if (staged === undefined) {
      await this.discardStaging(input.stagingKey, signal);
      return undefined;
    }
    if (staged.contentType !== contentType) {
      await this.discardStaging(input.stagingKey, signal);
      throw invalidRequest();
    }
    return {
      contentType,
      byteSize,
      bytes: staged.bytes,
      ...(described.lastModified === undefined
        ? {}
        : { lastModified: described.lastModified }),
      ...(described.etag === undefined ? {} : { etag: described.etag }),
    };
  }

  async publishObject(
    input: {
      readonly environment: 'production';
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: AvatarContentType;
      readonly bytes: Uint8Array;
      readonly byteSize?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.putFinalObject({
      objectKey: input.publishedKey,
      contentType: input.contentType,
      bytes: input.bytes,
      ...(signal === undefined ? {} : { signal }),
    });
    const published = await this.storage.describeFinalObject(
      input.publishedKey,
      signal,
    );
    if (
      published === undefined ||
      !isAvatarContentType(published.contentType) ||
      published.byteSize === undefined ||
      published.byteSize < 1 ||
      published.byteSize > AVATAR_MAX_BYTES
    ) {
      await this.storage
        .deleteObject(input.publishedKey)
        .catch(() => undefined);
      await this.discardStaging(input.stagingKey, signal);
      if (published === undefined) {
        throw uploadNotFound('NOT_FOUND', 'Avatar upload was not found');
      }
      if (
        published.byteSize !== undefined &&
        published.byteSize > AVATAR_MAX_BYTES
      ) {
        throw storedTooLarge();
      }
      throw invalidRequest();
    }
    this.publishedDescriptors.set(input.publishedKey, {
      contentType: published.contentType,
      byteSize: published.byteSize,
    });
  }

  private async discardStaging(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage
      .deleteStagingObject(objectKey, signal)
      .catch(() => undefined);
  }

  publicUrl(input: {
    readonly environment: 'production';
    readonly publishedKey: string;
  }): string {
    return this.storage.publicUrl(input.publishedKey);
  }

  async deleteStagingObject(
    input: {
      readonly environment: 'production';
      readonly stagingKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.deleteStagingObject(input.stagingKey, signal);
  }

  async deletePublishedObject(
    input: {
      readonly environment: 'production';
      readonly publishedKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.deleteObject(input.publishedKey, signal);
  }
}

import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  AVATAR_COMPLETION_WINDOW_MS,
  AVATAR_SWEEP_GRACE_MS,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  type Avatar,
  type AvatarContentType,
  avatarObjectKey,
  isAvatarObjectKey,
} from '@/modules/avatar/domain/avatar';
import type {
  PublishedUploadSession,
  UploadSessionCleanupCandidate,
  UploadSessionIntent,
  UploadSessionLookup,
  UploadSessionOwner,
  UploadSessionRepositoryPort,
  UploadSessionStoragePort,
} from '@/modules/uploads/public';
import type {
  AvatarAuditEvent,
  AvatarRepositoryPort,
} from './avatar-repository.port';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
} from './avatar-storage.port';
import {
  AVATAR_OPEN_UPLOAD_MAX,
  AVATAR_UPLOAD_ISSUANCE_MAX,
  AVATAR_UPLOAD_ISSUANCE_WINDOW_MS,
} from './avatar-upload.policy';

function avatarChanged(): AppError {
  return new AppError({
    code: 'AVATAR_CHANGED',
    message: 'The Avatar was changed by another request',
    retryable: false,
  });
}

function coreAsset(avatar: Avatar, created: boolean): PublishedUploadSession {
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
  implements UploadSessionRepositoryPort
{
  private readonly gates = new Map<
    string,
    { decide(result: Gate): void; result: Promise<GateResult> }
  >();

  constructor(
    private readonly repository: AvatarRepositoryPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createIntent(
    intent: UploadSessionIntent,
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

  async findUpload(owner: UploadSessionOwner): Promise<UploadSessionLookup> {
    const userId = owner.endUserId;
    const current = await this.repository.findByUser(userId);
    if (current?.assetId === owner.assetId) {
      return { kind: 'asset', asset: coreAsset(current, false) };
    }
    const grants = await this.repository.openUploadGrants(userId, this.now());
    const grant = grants.find((row) => row.assetId === owner.assetId);
    if (grant === undefined) return { kind: 'missing' };
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

  async rejectIntent(owner: UploadSessionOwner): Promise<void> {
    await this.repository.consumeUploadGrant(owner.endUserId, owner.assetId);
  }

  async beginPublication(input: {
    readonly owner: UploadSessionOwner;
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
    readonly owner: UploadSessionOwner;
    readonly now: Date;
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
    readonly requestId?: string;
    readonly contentType?: string;
    readonly byteSize?: number;
  }): Promise<PublishedUploadSession | 'revoked' | undefined> {
    const gate = this.gates.get(input.owner.assetId);
    if (gate === undefined) return undefined;
    const avatar: Avatar = {
      assetId: input.owner.assetId,
      userId: input.owner.endUserId,
      objectKey: avatarObjectKey(input.owner.endUserId, input.owner.assetId),
      contentType: (input.contentType ?? 'image/jpeg') as AvatarContentType,
      byteSize: input.byteSize ?? 0,
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

  async releasePublication(owner: UploadSessionOwner): Promise<void> {
    const gate = this.gates.get(owner.assetId);
    if (gate === undefined) return;
    gate.decide({ kind: 'refused', refusal: invalidRequest() });
    await gate.result;
    this.gates.delete(owner.assetId);
  }

  async cleanupCandidates(): Promise<readonly UploadSessionCleanupCandidate[]> {
    return [];
  }

  async removeCleanupCandidate(): Promise<boolean> {
    return true;
  }
}

export class AvatarCoreStorageAdapter implements UploadSessionStoragePort {
  constructor(
    private readonly storage: AvatarStoragePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createUploadUrl(input: {
    readonly environment: string;
    readonly stagingKey: string;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }> {
    const signed = await this.storage.createUploadUrl({
      objectKey: input.stagingKey,
      contentType: input.contentType as AvatarContentType,
    });
    return { ...signed, fields: {} };
  }

  async inspectObject(
    input: {
      readonly environment: string;
      readonly stagingKey: string;
      readonly byteSize: number;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly contentType: string | undefined;
        readonly byteSize: number | undefined;
        readonly bytes: Uint8Array;
        readonly lastModified?: Date;
        readonly etag?: string;
      }
    | undefined
  > {
    const described = await this.storage.describeStagingObject(
      input.stagingKey,
      signal,
    );
    if (described === undefined) return undefined;
    if (
      described.lastModified !== undefined &&
      this.now().getTime() - described.lastModified.getTime() >
        AVATAR_COMPLETION_WINDOW_MS
    ) {
      return undefined;
    }
    const staged = await this.storage.readStagingObject(
      input.stagingKey,
      described.etag,
      signal,
    );
    if (staged === undefined) return undefined;
    return {
      contentType: staged.contentType ?? described.contentType,
      byteSize: described.byteSize ?? staged.bytes.byteLength,
      bytes: staged.bytes,
      ...(described.lastModified === undefined
        ? {}
        : { lastModified: described.lastModified }),
      ...(described.etag === undefined ? {} : { etag: described.etag }),
    };
  }

  async publishObject(
    input: {
      readonly environment: string;
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: string;
      readonly bytes: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.putFinalObject({
      objectKey: input.publishedKey,
      contentType: input.contentType as AvatarContentType,
      bytes: input.bytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  publicUrl(input: {
    readonly environment: string;
    readonly publishedKey: string;
  }): string {
    return this.storage.publicUrl(input.publishedKey);
  }

  async deleteStagingObject(
    input: { readonly environment: string; readonly stagingKey: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.deleteStagingObject(input.stagingKey, signal);
  }

  async deletePublishedObject(
    input: { readonly environment: string; readonly publishedKey: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.storage.deleteObject(input.publishedKey, signal);
  }
}

export class AvatarCoreCandidateSource
  implements
    Pick<
      UploadSessionRepositoryPort,
      'cleanupCandidates' | 'removeCleanupCandidate'
    >
{
  private readonly startAfter = new Map<string, string>();

  constructor(
    private readonly repository: AvatarRepositoryPort,
    private readonly storage: AvatarStoragePort,
  ) {}

  async cleanupCandidates(input: {
    readonly now: Date;
    readonly orphanBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly UploadSessionCleanupCandidate[]> {
    const candidates: UploadSessionCleanupCandidate[] = [];
    const afterKey =
      input.after === undefined
        ? undefined
        : this.startAfter.get(input.after.assetId);
    const listedObjects: ListedAvatarObject[] = [];
    for await (const row of this.storage.listObjects('users/', afterKey)) {
      listedObjects.push(row);
    }
    for await (const row of this.storage.listStagingObjects(
      'users/',
      afterKey,
    )) {
      listedObjects.push(row);
    }
    const seen = new Set<string>();
    for (const listed of listedObjects) {
      if (seen.has(listed.objectKey)) continue;
      seen.add(listed.objectKey);
      if (!isAvatarObjectKey(listed.objectKey)) continue;
      if (
        listed.lastModified !== undefined &&
        listed.lastModified.getTime() > input.orphanBefore.getTime()
      ) {
        continue;
      }
      const parts = listed.objectKey.split('/');
      const userId = parts[1] ?? '';
      const assetId = parts[3] ?? '';
      const recorded = await this.repository.recordedObjectKeys([
        listed.objectKey,
      ]);
      if (recorded.has(listed.objectKey)) continue;
      candidates.push({
        kind: 'intent',
        assetId,
        environment: 'production',
        stagingKey: listed.objectKey,
        publishedKey: avatarObjectKey(userId, assetId),
        createdAt: listed.lastModified ?? new Date(0),
      });
      this.startAfter.set(assetId, listed.objectKey);
      if (candidates.length >= input.limit) break;
    }
    return candidates;
  }

  async removeCleanupCandidate(): Promise<boolean> {
    return true;
  }
}

export const AVATAR_SWEEP_ORPHAN_GRACE_MS = AVATAR_SWEEP_GRACE_MS;

import { AppError } from '@/common/errors/app-error';
import type { IdMinter } from '@/common/ids/prefixed-id';
import type { RequestContext } from '@/common/request-context/request-context';
import {
  type Avatar,
  type AvatarContentType,
  avatarObjectKey,
} from '@/modules/avatar/domain/avatar';
import {
  UploadSessionService,
  type UploadSessionServicePort,
} from '@/modules/uploads/public';

import type {
  AvatarAuditEvent,
  AvatarRepositoryPort,
} from './avatar-repository.port';
import type { AvatarStoragePort } from './avatar-storage.port';
import {
  AvatarCoreRepositoryAdapter,
  AvatarCoreStorageAdapter,
  avatarChanged,
} from './avatar-upload-session.adapters';
import {
  avatarUploadSessionPolicy,
  storageUnavailable,
} from './avatar-upload-session.policy';
import { AVATAR_COMPLETION_DEADLINE_MS } from './avatar-upload.policy';

export interface AvatarUpload {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly contentType: AvatarContentType;
  readonly byteSize: number;
  readonly expiresAt: Date;
}

/** An Avatar with the published URL it is read from (ADR-0069). */
export interface PublishedAvatar {
  readonly avatar: Avatar;
  readonly url: string;
}

export interface CompletedAvatar extends PublishedAvatar {
  /** `false` when an earlier completion of the same asset recorded it. */
  readonly created: boolean;
}

/** Maps Avatar's vocabulary onto the shared core; read/remove stay local. */
export class AvatarUploadService {
  private readonly core: UploadSessionServicePort;
  private readonly now: () => Date;

  constructor(
    private readonly avatars: AvatarRepositoryPort,
    private readonly storage: AvatarStoragePort,
    coreOrIdMinter: UploadSessionServicePort | IdMinter,
    nowOrCore: (() => Date) | UploadSessionServicePort = () => new Date(),
  ) {
    if (typeof coreOrIdMinter !== 'function') {
      this.core = coreOrIdMinter;
      this.now = typeof nowOrCore === 'function' ? nowOrCore : () => new Date();
      return;
    }
    const now = nowOrCore as () => Date;
    const policy = avatarUploadSessionPolicy();
    const storageAdapter = new AvatarCoreStorageAdapter(storage, now);
    this.core = new UploadSessionService(
      new AvatarCoreRepositoryAdapter(avatars, now, storageAdapter),
      storageAdapter,
      policy,
      coreOrIdMinter,
      now,
    );
    this.now = now;
  }

  private context(
    userId: string,
    requestId: string,
    signal: AbortSignal,
  ): RequestContext {
    const receivedAt = this.now();
    return {
      requestId,
      receivedAt,
      deadlineAt: new Date(
        receivedAt.getTime() + AVATAR_COMPLETION_DEADLINE_MS,
      ),
      operationTimeoutMs: AVATAR_COMPLETION_DEADLINE_MS,
      userId,
      environment: 'production',
      scopes: [],
      signal,
    };
  }

  async requestUpload(input: {
    readonly userId: string;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<AvatarUpload> {
    const grant = await this.core.create({
      context: this.context(
        input.userId,
        'avatar-upload',
        new AbortController().signal,
      ),
      contentType: input.contentType,
      byteSize: input.byteSize,
    });
    return {
      assetId: grant.assetId,
      uploadUrl: grant.uploadUrl,
      contentType: grant.contentType as AvatarContentType,
      byteSize: grant.byteSize,
      expiresAt: grant.uploadUrlExpiresAt,
    };
  }

  /**
   * `undefined` when the account has no Avatar, without touching storage: an
   * outage must never turn an empty account into an error.
   */
  async readAvatar(userId: string): Promise<PublishedAvatar | undefined> {
    const avatar = await this.avatars.findByUser(userId);
    return avatar === undefined ? undefined : this.published(avatar);
  }

  async completeUpload(input: {
    readonly userId: string;
    readonly assetId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<CompletedAvatar> {
    const signal =
      input.signal === undefined
        ? AbortSignal.timeout(AVATAR_COMPLETION_DEADLINE_MS)
        : AbortSignal.any([
            input.signal,
            AbortSignal.timeout(AVATAR_COMPLETION_DEADLINE_MS),
          ]);
    if (signal.aborted) throw storageUnavailable();
    const previous = await this.avatars.findByUser(input.userId);
    let published;
    try {
      published = await this.core.complete({
        context: this.context(input.userId, input.requestId, signal),
        assetId: input.assetId,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'AVATAR_CHANGED') {
        const key = avatarObjectKey(input.userId, input.assetId);
        await this.discardIfUnrecorded(input.userId, key);
        await this.storage
          .deleteStagingObject(key, signal)
          .catch(() => undefined);
      }
      throw error;
    }
    if (previous !== undefined && previous.assetId !== published.assetId) {
      await this.discardIfUnrecorded(input.userId, previous.objectKey);
    }
    const avatar: Avatar = {
      assetId: published.assetId,
      userId: input.userId,
      objectKey: avatarObjectKey(input.userId, published.assetId),
      contentType: published.contentType as AvatarContentType,
      byteSize: published.byteSize,
      acceptedAt: published.publishedAt,
    };
    return { ...this.published(avatar), created: published.created ?? false };
  }

  async removeAvatar(input: {
    readonly userId: string;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const { userId } = input;
    const removed = await this.avatars.withUserLock(userId, async (avatars) => {
      const current = await avatars.findByUser(userId);
      if (current === undefined) return undefined;
      const didRemove = await avatars.remove(
        userId,
        current.assetId,
        this.audit('avatar.removed', current, input.requestId),
      );
      if (didRemove || (await avatars.findByUser(userId)) === undefined) {
        return current;
      }
      return null;
    });
    if (removed === null) throw avatarChanged();
    if (removed !== undefined) {
      await this.discardIfUnrecorded(userId, removed.objectKey, input.signal);
    }
  }

  private published(avatar: Avatar): PublishedAvatar {
    return { avatar, url: this.storage.publicUrl(avatar.objectKey) };
  }

  private audit(
    action: AvatarAuditEvent['action'],
    avatar: Avatar,
    requestId: string,
  ): AvatarAuditEvent {
    return {
      action,
      assetId: avatar.assetId,
      requestId,
      occurredAt: this.now(),
    };
  }

  private async discardIfUnrecorded(
    userId: string,
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.avatars.withUserLock(userId, async (avatars) => {
        if ((await avatars.recordedObjectKeys([objectKey])).has(objectKey))
          return;
        await this.storage
          .deleteObject(objectKey, signal)
          .catch(() => undefined);
      });
    } catch {
      // Skip deletion if the guard cannot run; the sweep can retry later.
    }
  }
}

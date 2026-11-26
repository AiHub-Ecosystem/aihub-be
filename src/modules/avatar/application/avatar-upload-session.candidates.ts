import {
  avatarObjectKey,
  isAvatarObjectKey,
} from '@/modules/avatar/domain/avatar';
import type {
  UploadSessionCleanupCandidate,
  UploadSessionRepositoryPort,
} from '@/modules/uploads/public';

import type { AvatarRepositoryPort } from './avatar-repository.port';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
} from './avatar-storage.port';

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

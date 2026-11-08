import { InMemoryAvatarRepository } from '@/modules/avatar/testing/in-memory-avatar.repository';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
  StoredAvatarObject,
} from './avatar-storage.port';
import { AvatarUploadService } from './avatar-upload.service';

const USER = 'usr_01J00000000000000000000000';
const ASSET = 'ava_01J00000000000000000000001';
const NOW = new Date('2026-10-02T10:00:00.000Z');

class FakeStorage implements AvatarStoragePort {
  readonly staging = new Map<string, StoredAvatarObject>();
  readonly final = new Map<string, StoredAvatarObject>();
  readonly stagingBytes = new Map<string, string>();
  readonly finalBytes = new Map<string, string>();
  readonly calls: string[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  failFinalCheck = false;
  failStagingDelete = false;
  copyGate:
    | { readonly started: () => void; readonly wait: Promise<void> }
    | undefined;

  async createUploadUrl() {
    return { url: 'private', expiresAt: NOW };
  }
  publicUrl(key: string) {
    return `https://public.invalid/${key}`;
  }
  async describeStagingObject(key: string, signal?: AbortSignal) {
    this.calls.push('check-staging');
    this.signals.push(signal);
    return this.staging.get(key);
  }
  async describeFinalObject(key: string, signal?: AbortSignal) {
    this.calls.push('check-final');
    this.signals.push(signal);
    if (this.failFinalCheck) return undefined;
    return this.final.get(key);
  }
  async copyStagingToFinal(input: {
    readonly objectKey: string;
    readonly contentType: 'image/png' | 'image/jpeg' | 'image/webp';
    readonly signal?: AbortSignal;
    readonly stagingEtag?: string | undefined;
  }) {
    this.calls.push('copy');
    this.signals.push(input.signal);
    const object = this.staging.get(input.objectKey);
    if (object !== undefined)
      this.final.set(input.objectKey, {
        ...object,
        contentType: input.contentType,
      });
    const bytes = this.stagingBytes.get(input.objectKey);
    if (bytes !== undefined) this.finalBytes.set(input.objectKey, bytes);
    this.copyGate?.started();
    await this.copyGate?.wait;
  }
  async deleteObject(key: string, signal?: AbortSignal) {
    this.calls.push('delete-final');
    this.signals.push(signal);
    this.final.delete(key);
  }
  async deleteStagingObject(key: string, signal?: AbortSignal) {
    this.calls.push('delete-staging');
    this.signals.push(signal);
    if (this.failStagingDelete) throw new Error('delete failed');
    this.staging.delete(key);
    this.stagingBytes.delete(key);
  }
  async *listObjects(_prefix: string): AsyncIterable<ListedAvatarObject> {}
  async *listStagingObjects(
    _prefix: string,
  ): AsyncIterable<ListedAvatarObject> {}
}

function setup() {
  const repository = new InMemoryAvatarRepository();
  const storage = new FakeStorage();
  const service = new AvatarUploadService(
    repository,
    storage,
    () => ASSET,
    () => NOW,
  );
  const objectKey = `users/${USER}/avatar/${ASSET}/original`;
  storage.staging.set(objectKey, {
    contentType: 'image/png',
    byteSize: 12,
    lastModified: new Date(NOW.getTime() - 1000),
  });
  storage.stagingBytes.set(objectKey, 'accepted-original');
  return { repository, storage, service, objectKey };
}

describe('AvatarUploadService private staging', () => {
  it('publishes a copy that a later staging PUT cannot overwrite', async () => {
    const { service, storage, objectKey } = setup();
    await service.completeUpload({ userId: USER, assetId: ASSET });
    storage.staging.set(objectKey, {
      contentType: 'image/png',
      byteSize: 12,
      lastModified: NOW,
    });
    storage.stagingBytes.set(objectKey, 'replacement-bytes');
    expect(storage.finalBytes.get(objectKey)).toBe('accepted-original');
  });

  it('serializes same-asset completions across a replayed PUT', async () => {
    const { service, storage, objectKey } = setup();
    let beginCopy = (): void => undefined;
    let releaseCopy = (): void => undefined;
    const copyStarted = new Promise<void>((resolve) => {
      beginCopy = resolve;
    });
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    storage.copyGate = { started: beginCopy, wait: copyGate };
    const first = service.completeUpload({ userId: USER, assetId: ASSET });
    await copyStarted;
    storage.stagingBytes.set(objectKey, 'replacement-bytes');
    const second = service.completeUpload({ userId: USER, assetId: ASSET });
    releaseCopy();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { created: true },
      { created: false },
    ]);
    expect(storage.finalBytes.get(objectKey)).toBe('accepted-original');
    expect(storage.calls.filter((call) => call === 'copy')).toHaveLength(1);
  });

  it('checks staging before copy and checks the copied final object before recording', async () => {
    const { service, storage, repository } = setup();
    await service.completeUpload({ userId: USER, assetId: ASSET });
    // Verify staging was checked, copy ran, and final was checked — all three
    // must have happened for a record to be written.
    expect(storage.calls).toContain('check-staging');
    expect(storage.calls).toContain('copy');
    expect(storage.calls).toContain('check-final');
    expect(repository.avatars.get(USER)?.assetId).toBe(ASSET);
  });

  it('passes one completion deadline signal to every storage call while locked', async () => {
    const { service, storage, repository } = setup();
    const previous = {
      assetId: 'ava_01J00000000000000000000002',
      userId: USER,
      objectKey: `users/${USER}/avatar/ava_01J00000000000000000000002/original`,
      contentType: 'image/png' as const,
      byteSize: 1,
      acceptedAt: NOW,
    };
    repository.avatars.set(USER, previous);
    storage.final.set(previous.objectKey, {
      contentType: previous.contentType,
      byteSize: previous.byteSize,
      lastModified: NOW,
    });

    await service.completeUpload({ userId: USER, assetId: ASSET });

    // All five storage calls must be present (staging check, copy, final check,
    // old-object delete, post-record staging cleanup).
    expect(storage.calls).toContain('check-staging');
    expect(storage.calls).toContain('copy');
    expect(storage.calls).toContain('check-final');
    expect(storage.calls).toContain('delete-final');
    expect(storage.calls).toContain('delete-staging');
    expect(storage.signals).toHaveLength(5);
    expect(storage.signals[0]).toBeInstanceOf(AbortSignal);
    expect(
      storage.signals.every((signal) => signal === storage.signals[0]),
    ).toBe(true);
  });

  it('does not copy when the completion deadline aborts before publication', async () => {
    const { service, storage } = setup();
    const deadline = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    try {
      await expect(
        service.completeUpload({ userId: USER, assetId: ASSET }),
      ).rejects.toMatchObject({ code: 'AVATAR_STORAGE_UNAVAILABLE' });
      expect(storage.calls).toEqual(['check-staging']);
      expect(storage.signals[0]?.aborted).toBe(true);
    } finally {
      deadline.mockRestore();
    }
  });

  it('does not copy when the early staging check fails', async () => {
    const { service, storage } = setup();
    storage.staging.clear();
    await expect(
      service.completeUpload({ userId: USER, assetId: ASSET }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(storage.calls).not.toContain('copy');
  });

  it('discards both copies when another first upload wins the record race', async () => {
    const { service, storage, repository, objectKey } = setup();
    const winnerId = 'ava_01J00000000000000000000002';
    const winnerKey = `users/${USER}/avatar/${winnerId}/original`;
    repository.beforeNextChange = () => {
      repository.avatars.set(USER, {
        assetId: winnerId,
        userId: USER,
        objectKey: winnerKey,
        contentType: 'image/png',
        byteSize: 1,
        acceptedAt: NOW,
      });
    };
    await expect(
      service.completeUpload({ userId: USER, assetId: ASSET }),
    ).rejects.toMatchObject({ code: 'AVATAR_CHANGED' });
    expect(storage.final.has(objectKey)).toBe(false);
    expect(storage.staging.has(objectKey)).toBe(false);
  });

  it('discards both copies when another replacement wins the conditional update', async () => {
    const { service, storage, repository, objectKey } = setup();
    const previousId = 'ava_01J00000000000000000000002';
    const winnerId = 'ava_01J00000000000000000000003';
    const previousKey = `users/${USER}/avatar/${previousId}/original`;
    const winnerKey = `users/${USER}/avatar/${winnerId}/original`;
    const previous = {
      assetId: previousId,
      userId: USER,
      objectKey: previousKey,
      contentType: 'image/png' as const,
      byteSize: 1,
      acceptedAt: NOW,
    };
    repository.avatars.set(USER, previous);
    repository.beforeNextChange = () =>
      repository.avatars.set(USER, {
        ...previous,
        assetId: winnerId,
        objectKey: winnerKey,
      });
    await expect(
      service.completeUpload({ userId: USER, assetId: ASSET }),
    ).rejects.toMatchObject({ code: 'AVATAR_CHANGED' });
    expect(storage.final.has(objectKey)).toBe(false);
    expect(storage.staging.has(objectKey)).toBe(false);
  });

  it('deletes final and staging when the final check fails', async () => {
    const { service, storage, objectKey } = setup();
    storage.failFinalCheck = true;
    await expect(
      service.completeUpload({ userId: USER, assetId: ASSET }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(storage.final.has(objectKey)).toBe(false);
    expect(storage.staging.has(objectKey)).toBe(false);
  });

  it('lets completion succeed when post-record staging cleanup fails', async () => {
    const { service, storage, repository } = setup();
    storage.failStagingDelete = true;
    await expect(
      service.completeUpload({ userId: USER, assetId: ASSET }),
    ).resolves.toMatchObject({ created: true });
    expect(repository.avatars.get(USER)?.assetId).toBe(ASSET);
  });

  it('retries a copy left behind before the record write', async () => {
    const { service, storage, objectKey } = setup();
    storage.final.set(objectKey, {
      contentType: 'image/png',
      byteSize: 12,
      lastModified: NOW,
    });
    await expect(
      service.completeUpload({ userId: USER, assetId: ASSET }),
    ).resolves.toMatchObject({ created: true });
    expect(storage.calls.filter((call) => call === 'copy')).toHaveLength(1);
  });
});

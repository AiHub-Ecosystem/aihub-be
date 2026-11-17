import { randomBytes } from 'node:crypto';

import sharp from 'sharp';

import {
  reserveRasterImageProcessing,
  serializeRasterImageProcessing,
} from '@/common/image/raster-image';
import { InMemoryAvatarRepository } from '@/modules/avatar/testing/in-memory-avatar.repository';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
  StagedAvatarObject,
  StoredAvatarObject,
} from './avatar-storage.port';
import {
  AVATAR_OPEN_UPLOAD_MAX,
  AVATAR_UPLOAD_ISSUANCE_MAX,
} from './avatar-upload.policy';
import { AvatarUploadService } from './avatar-upload.service';

const USER = 'usr_01J00000000000000000000000';
const ASSET = 'ava_01J00000000000000000000001';
const REQUEST_ID = 'req_01J00000000000000000000000';
const NOW = new Date('2026-10-02T10:00:00.000Z');

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let cachedPng: Uint8Array | undefined;

async function pngBytes(): Promise<Uint8Array> {
  cachedPng ??= await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .png()
    .toBuffer();
  return cachedPng;
}

/** A different image, so a swapped staging PUT is visible in the bytes. */
async function otherPngBytes(): Promise<Uint8Array> {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .png()
    .toBuffer();
}

class FakeStorage implements AvatarStoragePort {
  readonly staging = new Map<string, StoredAvatarObject>();
  readonly final = new Map<string, StoredAvatarObject>();
  readonly stagingBytes = new Map<string, Uint8Array>();
  readonly finalBytes = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  failFinalCheck = false;
  failFinalDelete = false;
  failStagingDelete = false;
  readStarted: (() => void) | undefined;
  describeGate:
    | { readonly started: () => void; readonly wait: Promise<void> }
    | undefined;
  copyGate:
    | { readonly started: () => void; readonly wait: Promise<void> }
    | undefined;

  async createUploadUrl() {
    // A real grant lives five minutes; an already-expired one holds no slot.
    return { url: 'private', expiresAt: new Date(NOW.getTime() + 5 * 60_000) };
  }
  publicUrl(key: string) {
    return `https://public.invalid/${key}`;
  }
  async describeStagingObject(key: string, signal?: AbortSignal) {
    this.calls.push('check-staging');
    this.signals.push(signal);
    this.describeGate?.started();
    await this.describeGate?.wait;
    return this.staging.get(key);
  }
  async describeFinalObject(key: string, signal?: AbortSignal) {
    this.calls.push('check-final');
    this.signals.push(signal);
    if (this.failFinalCheck) return undefined;
    return this.final.get(key);
  }
  async readStagingObject(
    objectKey: string,
    _etag: string | undefined,
    signal?: AbortSignal,
  ): Promise<StagedAvatarObject | undefined> {
    this.calls.push('read-staging');
    this.signals.push(signal);
    this.readStarted?.();
    const object = this.staging.get(objectKey);
    const bytes = this.stagingBytes.get(objectKey);
    return object === undefined || bytes === undefined
      ? undefined
      : { contentType: object.contentType, bytes };
  }
  async putFinalObject(input: {
    readonly objectKey: string;
    readonly contentType: 'image/png' | 'image/jpeg' | 'image/webp';
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }) {
    this.calls.push('copy');
    this.signals.push(input.signal);
    this.final.set(input.objectKey, {
      contentType: input.contentType,
      byteSize: input.bytes.byteLength,
      lastModified: NOW,
    });
    this.finalBytes.set(input.objectKey, input.bytes);
    this.copyGate?.started();
    await this.copyGate?.wait;
  }
  async deleteObject(key: string, signal?: AbortSignal) {
    this.calls.push('delete-final');
    this.signals.push(signal);
    if (this.failFinalDelete) throw new Error('delete failed');
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

async function setup() {
  const repository = new InMemoryAvatarRepository();
  const storage = new FakeStorage();
  // Distinct per call: each grant is its own object and its own slot.
  let minted = 0;
  const service = new AvatarUploadService(
    repository,
    storage,
    () => {
      minted += 1;
      return minted === 1
        ? ASSET
        : `ava_01J000000000000000000000${String(minted).padStart(2, '0')}`;
    },
    () => NOW,
  );
  const objectKey = `users/${USER}/avatar/${ASSET}/original`;
  storage.staging.set(objectKey, {
    contentType: 'image/png',
    byteSize: 12,
    lastModified: new Date(NOW.getTime() - 1000),
  });
  storage.stagingBytes.set(objectKey, await pngBytes());
  return { repository, storage, service, objectKey };
}

function seedPreviousAvatar(
  repository: InMemoryAvatarRepository,
  storage: FakeStorage,
) {
  const avatar = {
    assetId: 'ava_01J00000000000000000000002',
    userId: USER,
    objectKey: `users/${USER}/avatar/ava_01J00000000000000000000002/original`,
    contentType: 'image/png' as const,
    byteSize: 1,
    acceptedAt: NOW,
  };
  repository.avatars.set(USER, avatar);
  storage.final.set(avatar.objectKey, {
    contentType: avatar.contentType,
    byteSize: avatar.byteSize,
    lastModified: NOW,
  });
  return avatar;
}

describe('AvatarUploadService private staging', () => {
  it('publishes a copy that a later staging PUT cannot overwrite', async () => {
    const { service, storage, objectKey } = await setup();
    await service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });
    const published = storage.finalBytes.get(objectKey);
    if (published === undefined) throw new Error('Avatar was not published');
    storage.staging.set(objectKey, {
      contentType: 'image/png',
      byteSize: 12,
      lastModified: NOW,
    });
    storage.stagingBytes.set(objectKey, await otherPngBytes());
    expect(storage.finalBytes.get(objectKey)).toBe(published);
    expect(await sharp(published).metadata()).toMatchObject({
      width: 2,
      height: 2,
    });
  });

  it('serializes same-asset completions across a replayed PUT', async () => {
    const { service, storage, objectKey } = await setup();
    const describeStarted = deferred();
    const describeGate = deferred();
    storage.describeGate = {
      started: describeStarted.resolve,
      wait: describeGate.promise,
    };
    const copyStarted = deferred();
    const copyGate = deferred();
    storage.copyGate = { started: copyStarted.resolve, wait: copyGate.promise };
    const first = service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });
    await describeStarted.promise;
    const second = service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });
    describeGate.resolve();
    await copyStarted.promise;
    storage.stagingBytes.set(objectKey, await otherPngBytes());
    copyGate.resolve();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { created: true },
      { created: false },
    ]);
    const published = storage.finalBytes.get(objectKey);
    if (published === undefined) throw new Error('Avatar was not published');
    expect(await sharp(published).metadata()).toMatchObject({
      width: 2,
      height: 2,
    });
    expect(storage.calls.filter((call) => call === 'copy')).toHaveLength(1);
    expect(
      storage.calls.filter((call) => call === 'read-staging'),
    ).toHaveLength(1);
  });

  it('coalesces completion while publication is in progress', async () => {
    const { service, storage, repository } = await setup();
    const copyStarted = deferred();
    const copyGate = deferred();
    storage.copyGate = { started: copyStarted.resolve, wait: copyGate.promise };
    const first = service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });
    await copyStarted.promise;

    const second = service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });

    copyGate.resolve();
    await expect(first).resolves.toMatchObject({ created: true });
    await expect(second).resolves.toMatchObject({ created: false });
    expect(
      storage.calls.filter((call) => call === 'read-staging'),
    ).toHaveLength(1);
    expect(repository.avatars.get(USER)?.assetId).toBe(ASSET);
  });

  it('publishes bytes stripped of EXIF, ICC, and XMP metadata', async () => {
    const { service, storage, objectKey } = await setup();
    const withMetadata = await sharp(await pngBytes())
      .withExif({
        IFD0: { Make: 'private-camera', Model: 'private-model' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '10/1 0/1 0/1' },
      })
      .withIccProfile('srgb')
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>')
      .jpeg()
      .toBuffer();
    storage.staging.set(objectKey, {
      contentType: 'image/jpeg',
      byteSize: withMetadata.byteLength,
      lastModified: NOW,
    });
    storage.stagingBytes.set(objectKey, withMetadata);
    expect((await sharp(withMetadata).metadata()).exif).toBeDefined();

    await service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });

    const published = storage.finalBytes.get(objectKey);
    expect(published).toBeDefined();
    if (published === undefined) throw new Error('Avatar was not published');
    const metadata = await sharp(published).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(published.byteLength).not.toBe(withMetadata.byteLength);
  });

  it('rejects a re-encoded image that grows beyond the size limit', async () => {
    const { service, storage, objectKey } = await setup();
    const raw = randomBytes(1300 * 1300);
    const compressed = await sharp(raw, {
      raw: { width: 1300, height: 1300, channels: 1 },
    })
      .png({ palette: true, colours: 256, compressionLevel: 9 })
      .toBuffer();
    expect(compressed.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    const reencoded = await sharp(compressed).png().toBuffer();
    expect(reencoded.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    storage.staging.set(objectKey, {
      contentType: 'image/png',
      byteSize: compressed.byteLength,
      lastModified: NOW,
    });
    storage.stagingBytes.set(objectKey, compressed);

    await expect(
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message:
        'Avatar image is too large after processing; use a smaller image',
    });
  });

  it('skips queued decoding when the completion is aborted', async () => {
    const { service, storage } = await setup();
    let release = (): void => undefined;
    let started = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockerAdmission = reserveRasterImageProcessing('avatar');
    const blocker = serializeRasterImageProcessing(
      blockerAdmission,
      new AbortController().signal,
      async () => {
        started();
        await gate;
      },
    );
    await ready;
    let stagingRead = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      stagingRead = resolve;
    });
    storage.readStarted = stagingRead;
    const controller = new AbortController();
    const completion = service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
      signal: controller.signal,
    });
    await readStarted;
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'AVATAR_STORAGE_UNAVAILABLE',
    });
    release();
    await blocker;
    blockerAdmission.release();
    expect(storage.calls).not.toContain('copy');
  });

  it('checks staging before copy and checks the copied final object before recording', async () => {
    const { service, storage, repository } = await setup();
    await service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });
    // Verify staging was checked, copy ran, and final was checked — all three
    // must have happened for a record to be written.
    expect(storage.calls).toContain('check-staging');
    expect(storage.calls).toContain('copy');
    expect(storage.calls).toContain('check-final');
    expect(repository.avatars.get(USER)?.assetId).toBe(ASSET);
  });

  it('uses the completion signal for publication and staging cleanup', async () => {
    const { service, storage, repository } = await setup();
    seedPreviousAvatar(repository, storage);

    await service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });

    // Final-object cleanup follows the committed row change.
    expect(storage.calls).toContain('check-staging');
    expect(storage.calls).toContain('copy');
    expect(storage.calls).toContain('check-final');
    expect(storage.calls).toContain('delete-final');
    expect(storage.calls).toContain('delete-staging');
    expect(storage.signals).toHaveLength(6);
    expect(storage.signals[0]).toBeInstanceOf(AbortSignal);
    expect(storage.signals[4]).toBeUndefined();
    expect(storage.signals[5]).toBe(storage.signals[0]);
  });

  it('does not copy when the completion deadline aborts before publication', async () => {
    const { service, storage } = await setup();
    const deadline = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    try {
      await expect(
        service.completeUpload({
          userId: USER,
          assetId: ASSET,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'AVATAR_STORAGE_UNAVAILABLE' });
      expect(storage.calls).toEqual(['check-staging', 'read-staging']);
      expect(storage.signals[0]?.aborted).toBe(true);
    } finally {
      deadline.mockRestore();
    }
  });

  it('does not copy when the early staging check fails', async () => {
    const { service, storage } = await setup();
    storage.staging.clear();
    await expect(
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(storage.calls).not.toContain('copy');
  });

  it('discards both copies when another first upload wins the record race', async () => {
    const { service, storage, repository, objectKey } = await setup();
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
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'AVATAR_CHANGED' });
    expect(storage.final.has(objectKey)).toBe(false);
    expect(storage.staging.has(objectKey)).toBe(false);
  });

  it('discards both copies when another replacement wins the conditional update', async () => {
    const { service, storage, repository, objectKey } = await setup();
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
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'AVATAR_CHANGED' });
    expect(storage.final.has(objectKey)).toBe(false);
    expect(storage.staging.has(objectKey)).toBe(false);
  });

  it('keeps a candidate adopted while losing-completion cleanup waits', async () => {
    const { service, storage, repository, objectKey } = await setup();
    const previousId = 'ava_01J00000000000000000000002';
    const firstWinnerId = 'ava_01J00000000000000000000003';
    const secondWinnerId = 'ava_01J00000000000000000000004';
    const previousKey = `users/${USER}/avatar/${previousId}/original`;
    const firstWinnerKey = `users/${USER}/avatar/${firstWinnerId}/original`;
    const previous = {
      assetId: previousId,
      userId: USER,
      objectKey: previousKey,
      contentType: 'image/png' as const,
      byteSize: 1,
      acceptedAt: NOW,
    };
    repository.avatars.set(USER, previous);
    storage.final.set(previousKey, {
      contentType: previous.contentType,
      byteSize: previous.byteSize,
      lastModified: NOW,
    });
    const cleanupStarted = deferred();
    const cleanupGate = deferred();
    repository.beforeNextChange = () => {
      repository.avatars.set(USER, {
        ...previous,
        assetId: firstWinnerId,
        objectKey: firstWinnerKey,
      });
      repository.beforeNextLock = async () => {
        cleanupStarted.resolve();
        await cleanupGate.promise;
      };
    };

    const losing = service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });
    await cleanupStarted.promise;

    const secondKey = `users/${USER}/avatar/${secondWinnerId}/original`;
    storage.staging.set(secondKey, {
      contentType: 'image/png',
      byteSize: 12,
      lastModified: NOW,
    });
    storage.stagingBytes.set(secondKey, await pngBytes());
    await service.completeUpload({
      userId: USER,
      assetId: secondWinnerId,
      requestId: REQUEST_ID,
    });
    await service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });

    cleanupGate.resolve();
    await expect(losing).rejects.toMatchObject({ code: 'AVATAR_CHANGED' });
    expect(repository.avatars.get(USER)?.assetId).toBe(ASSET);
    expect(storage.finalBytes.has(objectKey)).toBe(true);
  });

  it('deletes final and staging when the final check fails', async () => {
    const { service, storage, objectKey } = await setup();
    storage.failFinalCheck = true;
    await expect(
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(storage.final.has(objectKey)).toBe(false);
    expect(storage.staging.has(objectKey)).toBe(false);
  });

  it('lets completion succeed when post-record staging cleanup fails', async () => {
    const { service, storage, repository } = await setup();
    storage.failStagingDelete = true;
    await expect(
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ created: true });
    expect(repository.avatars.get(USER)?.assetId).toBe(ASSET);
  });

  it('commits avatar changes before best-effort object cleanup', async () => {
    const { service, storage, repository } = await setup();
    const previous = seedPreviousAvatar(repository, storage);
    storage.failFinalDelete = true;

    await expect(
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ created: true });
    expect(repository.avatars.get(USER)?.assetId).toBe(ASSET);
    expect(storage.final.has(previous.objectKey)).toBe(true);

    await service.removeAvatar({ userId: USER, requestId: REQUEST_ID });
    expect(repository.avatars.has(USER)).toBe(false);
    expect(storage.final.has(`users/${USER}/avatar/${ASSET}/original`)).toBe(
      true,
    );
  });

  it('retries a copy left behind before the record write', async () => {
    const { service, storage, objectKey } = await setup();
    storage.final.set(objectKey, {
      contentType: 'image/png',
      byteSize: 12,
      lastModified: NOW,
    });
    await expect(
      service.completeUpload({
        userId: USER,
        assetId: ASSET,
        requestId: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ created: true });
    expect(storage.calls.filter((call) => call === 'copy')).toHaveLength(1);
  });
});

describe('AvatarUploadService upload grants (#374)', () => {
  const upload = { contentType: 'image/png', byteSize: 12 } as const;

  it('records an open grant for the account so outstanding URLs are countable', async () => {
    const { service, repository } = await setup();

    const granted = await service.requestUpload({ userId: USER, ...upload });

    expect(repository.openUploads(USER, NOW)).toEqual([
      expect.objectContaining({
        assetId: granted.assetId,
        objectKey: `users/${USER}/avatar/${granted.assetId}/original`,
        expiresAt: granted.expiresAt,
      }),
    ]);
  });

  it('refuses a further URL while the account holds the maximum open ones', async () => {
    const { service, repository } = await setup();
    for (let held = 0; held < AVATAR_OPEN_UPLOAD_MAX; held += 1) {
      await service.requestUpload({ userId: USER, ...upload });
    }

    await expect(
      service.requestUpload({ userId: USER, ...upload }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(repository.openUploads(USER, NOW)).toHaveLength(
      AVATAR_OPEN_UPLOAD_MAX,
    );
  });

  it('frees the slot once the grant is consumed by a completion', async () => {
    const { service, repository, storage, objectKey } = await setup();
    await service.requestUpload({ userId: USER, ...upload });
    await service.completeUpload({
      userId: USER,
      assetId: ASSET,
      requestId: REQUEST_ID,
    });

    expect(storage.final.has(objectKey)).toBe(true);
    expect(repository.openUploads(USER, NOW)).toEqual([]);
    await expect(
      service.requestUpload({ userId: USER, ...upload }),
    ).resolves.toMatchObject({ contentType: 'image/png' });
  });

  it('drops a grant that has outlived its URL, so an abandoned upload does not hold a slot', async () => {
    const { service, repository } = await setup();
    await service.requestUpload({ userId: USER, ...upload });
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

    const [still] = repository.openUploads(USER, later);
    expect(still).toBeUndefined();
  });

  it('caps issuance per account over a rolling window, however many are completed', async () => {
    const { service, repository } = await setup();
    for (let issued = 0; issued < AVATAR_UPLOAD_ISSUANCE_MAX; issued += 1) {
      const granted = await service.requestUpload({ userId: USER, ...upload });
      // Consume the slot each time, so nothing is refused for holding too many.
      await repository.consumeUploadGrant(USER, granted.assetId);
    }
    expect(repository.openUploads(USER, NOW)).toEqual([]);

    await expect(
      service.requestUpload({ userId: USER, ...upload }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('counts per account, so another account is unaffected', async () => {
    const { service, repository } = await setup();
    const other = 'usr_01J00000000000000000000009';
    for (let issued = 0; issued < AVATAR_UPLOAD_ISSUANCE_MAX; issued += 1) {
      const granted = await service.requestUpload({ userId: USER, ...upload });
      await repository.consumeUploadGrant(USER, granted.assetId);
    }

    await expect(
      service.requestUpload({ userId: other, ...upload }),
    ).resolves.toMatchObject({ contentType: 'image/png' });
  });
});

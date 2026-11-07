import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  SpeakingAudioAsset,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';
import {
  speakingAudioObjectKey,
  speakingAudioStagingObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from './speaking-audio-upload.port';
import { SpeakingAudioUploadService } from './speaking-audio-upload.service';

const ASSET_ID = 'aud_01J00000000000000000000001';
const NOW = new Date('2026-10-03T04:00:00.000Z');
type Stored = { contentType: string; byteSize: number; bytes: string };

class Repository implements SpeakingAudioUploadRepositoryPort {
  intent: SpeakingAudioUploadIntent | undefined;
  asset: SpeakingAudioAsset | undefined;
  rejectCalls = 0;
  failCompletionOnce = false;

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    this.intent = intent;
  }
  async findUpload() {
    return this.asset !== undefined
      ? { kind: 'asset' as const, asset: this.asset }
      : this.intent === undefined
        ? { kind: 'missing' as const }
        : { kind: 'intent' as const, intent: this.intent };
  }
  async confirmRefreshableIntent(): Promise<boolean> {
    return true;
  }
  async rejectIntent(): Promise<boolean> {
    this.rejectCalls += 1;
    if (this.intent === undefined || this.intent.status !== 'open')
      return false;
    this.intent = { ...this.intent, status: 'rejected' };
    return true;
  }
  async removeRejectedIntent(): Promise<void> {
    this.intent = undefined;
  }
  async completeIntent(input: { readonly asset: SpeakingAudioAsset }): Promise<
    'created' | 'already_completed' | 'missing'
  > {
    if (this.failCompletionOnce) {
      this.failCompletionOnce = false;
      throw new Error('simulated crash after copy');
    }
    this.asset = input.asset;
    this.intent = undefined;
    return 'created';
  }
  async listCleanupCandidates() {
    return [];
  }
  async removeCleanupCandidate(): Promise<boolean> {
    return true;
  }
}

class Storage implements SpeakingAudioAssetStoragePort {
  readonly objects = new Map<string, Stored>();
  readonly described: string[] = [];
  readonly deleted: string[] = [];
  readonly events: string[] = [];
  readonly signed: string[] = [];
  corruptFinal = false;
  failStageDelete = false;

  async createUploadUrl(input: { readonly objectKey: string }) {
    this.signed.push(input.objectKey);
    return {
      url: 'https://storage.test/upload',
      expiresAt: new Date(NOW.getTime() + 300_000),
    };
  }
  async describeObject(input: { readonly objectKey: string }) {
    this.events.push('describe');
    this.described.push(input.objectKey);
    const object = this.objects.get(input.objectKey);
    return object === undefined
      ? undefined
      : { contentType: object.contentType, byteSize: object.byteSize };
  }
  async copyObject(input: {
    readonly sourceObjectKey: string;
    readonly destinationObjectKey: string;
  }): Promise<void> {
    this.events.push('copy');
    const source = this.objects.get(input.sourceObjectKey);
    if (source !== undefined) {
      this.objects.set(
        input.destinationObjectKey,
        this.corruptFinal
          ? { ...source, contentType: 'audio/ogg' }
          : { ...source },
      );
    }
  }
  async deleteObject(input: { readonly objectKey: string }): Promise<void> {
    this.deleted.push(input.objectKey);
    if (this.failStageDelete && input.objectKey.endsWith('/upload'))
      throw new Error('delete unavailable');
    this.objects.delete(input.objectKey);
  }
}

function setup() {
  const repository = new Repository();
  const storage = new Storage();
  const service = new SpeakingAudioUploadService(
    repository,
    storage,
    () => ASSET_ID,
    () => NOW,
  );
  const context = createRequestContext({
    requestId: 'req_test',
    receivedAt: NOW,
    deadlineMs: 10_000,
    organizationId: 'org_test',
    environment: 'sandbox',
    userId: 'student-test',
    scopes: ['speaking:grade'],
  });
  const intent: SpeakingAudioUploadIntent = {
    assetId: ASSET_ID,
    organizationId: 'org_test',
    endUserId: 'student-test',
    environment: 'sandbox',
    objectKey: speakingAudioObjectKey('org_test', ASSET_ID),
    contentType: 'audio/wav',
    byteSize: 1_024,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    status: 'open',
  };
  return { repository, storage, service, context, intent };
}

async function openUpload(h: ReturnType<typeof setup>) {
  const grant = await h.service.requestUpload({
    context: h.context,
    contentType: 'audio/wav',
    byteSize: 1_024,
  });
  return {
    grant,
    stagingKey: speakingAudioStagingObjectKey('org_test', ASSET_ID),
  };
}

function stored(bytes = 'accepted bytes'): Stored {
  return { contentType: 'audio/wav', byteSize: 1_024, bytes };
}

describe('SpeakingAudioUploadService staging completion', () => {
  it('publishes only the accepted copy when the still-live staging URL is reused', async () => {
    const h = setup();
    const { grant, stagingKey } = await openUpload(h);
    expect(grant.objectKey).toBe(h.intent.objectKey);
    expect(h.storage.signed).toEqual([stagingKey]);
    h.storage.objects.set(stagingKey, stored());

    await h.service.completeUpload({ context: h.context, assetId: ASSET_ID });
    h.storage.objects.set(stagingKey, stored('replacement bytes'));

    expect(h.storage.objects.get(h.intent.objectKey)?.bytes).toBe(
      'accepted bytes',
    );
    expect(h.repository.asset?.objectKey).toBe(h.intent.objectKey);
    expect(h.storage.events).toEqual(['describe', 'copy', 'describe']);
  });

  it('checks the final copy after copying and deletes both keys on final refusal', async () => {
    const h = setup();
    const { stagingKey } = await openUpload(h);
    h.storage.objects.set(stagingKey, stored());
    h.storage.corruptFinal = true;

    await expect(
      h.service.completeUpload({ context: h.context, assetId: ASSET_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(h.storage.events).toEqual(['describe', 'copy', 'describe']);
    expect(h.storage.deleted).toEqual([h.intent.objectKey, stagingKey]);
    expect(h.repository.rejectCalls).toBe(1);
    expect(h.repository.asset).toBeUndefined();
  });

  it('does not copy when the early staging check refuses the object', async () => {
    const h = setup();
    const { stagingKey } = await openUpload(h);
    h.storage.objects.set(stagingKey, { ...stored(), byteSize: 1_023 });

    await expect(
      h.service.completeUpload({ context: h.context, assetId: ASSET_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(h.storage.events).toEqual(['describe']);
    expect(h.storage.deleted).toEqual([h.intent.objectKey, stagingKey]);
    expect(h.repository.rejectCalls).toBe(1);
  });

  it('retries a copy after a crash before the asset row and remains idempotent', async () => {
    const h = setup();
    const { stagingKey } = await openUpload(h);
    h.storage.objects.set(stagingKey, stored());
    h.repository.failCompletionOnce = true;

    await expect(
      h.service.completeUpload({ context: h.context, assetId: ASSET_ID }),
    ).rejects.toThrow('simulated crash after copy');
    await expect(
      h.service.completeUpload({ context: h.context, assetId: ASSET_ID }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      h.service.completeUpload({ context: h.context, assetId: ASSET_ID }),
    ).resolves.toMatchObject({ created: false });

    expect(h.storage.events.filter((event) => event === 'copy')).toHaveLength(
      2,
    );
    expect(h.repository.asset?.objectKey).toBe(h.intent.objectKey);
  });

  it('keeps completion successful when staging deletion fails after the asset row', async () => {
    const h = setup();
    const { stagingKey } = await openUpload(h);
    h.storage.objects.set(stagingKey, stored());
    h.storage.failStageDelete = true;

    await expect(
      h.service.completeUpload({ context: h.context, assetId: ASSET_ID }),
    ).resolves.toMatchObject({ created: true });
    expect(h.repository.asset).toBeDefined();
    expect(h.storage.objects.get(h.intent.objectKey)?.bytes).toBe(
      'accepted bytes',
    );
  });
});

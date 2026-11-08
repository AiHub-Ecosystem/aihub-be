import { getMetrics } from '@/common/observability/metrics';
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
  SpeakingAudioCeilingDecision,
  SpeakingAudioOrganizationHolding,
} from './speaking-audio-org-ceiling.policy';
import {
  SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX,
  SPEAKING_AUDIO_ORG_STORED_BYTES_MAX,
} from './speaking-audio-org-ceiling.policy';
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
  /** What the Org currently holds; a test sets it to reach a ceiling. */
  holding: SpeakingAudioOrganizationHolding = {
    openIntents: 0,
    issuedInWindow: 0,
    storedBytes: 0,
  };
  rejectedCount = 0;
  failCompletionOnce = false;
  activeCompletions = 0;
  completionTail: Promise<void> = Promise.resolve();
  onSecondCompletionWaiting: (() => void) | undefined;
  afterAssetRecorded: (() => Promise<void>) | undefined;

  async createIntent(intent: SpeakingAudioUploadIntent): Promise<void> {
    this.intent = intent;
  }
  async createIntentWithinCeiling(input: {
    readonly intent: SpeakingAudioUploadIntent;
    readonly decide: (
      holding: SpeakingAudioOrganizationHolding,
    ) => SpeakingAudioCeilingDecision;
  }): Promise<SpeakingAudioCeilingDecision> {
    const decision = input.decide(this.holding);
    if (decision.kind === 'refused') return decision;
    this.intent = input.intent;
    return decision;
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
  async removeRejectedIntent(): Promise<void> {
    this.intent = undefined;
  }
  async completeIntent(
    input: Parameters<SpeakingAudioUploadRepositoryPort['completeIntent']>[0],
  ): Promise<
    Awaited<ReturnType<SpeakingAudioUploadRepositoryPort['completeIntent']>>
  > {
    const previous = this.completionTail;
    let release = () => {};
    this.completionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (this.activeCompletions > 0) this.onSecondCompletionWaiting?.();
    this.activeCompletions += 1;
    await previous;
    try {
      if (this.asset !== undefined) {
        return { kind: 'already_completed', asset: this.asset };
      }
      const intent = this.intent;
      if (
        intent === undefined ||
        intent.status !== 'open' ||
        intent.expiresAt <= input.now()
      ) {
        return { kind: 'missing' };
      }
      const prepared = await input.prepare(intent);
      if (prepared.kind === 'refused') {
        this.rejectedCount += 1;
        this.intent = { ...intent, status: 'rejected' };
        return { kind: 'refused', refusal: prepared.refusal };
      }
      if (intent.expiresAt <= input.now()) return { kind: 'missing' };
      if (this.failCompletionOnce) {
        this.failCompletionOnce = false;
        throw new Error('simulated crash after copy');
      }
      this.asset = prepared.asset;
      await this.afterAssetRecorded?.();
      this.intent = undefined;
      return { kind: 'created', asset: prepared.asset };
    } finally {
      this.activeCompletions -= 1;
      release();
    }
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
  readonly operationSignals: (AbortSignal | undefined)[] = [];
  corruptFinal = false;
  failStageDelete = false;
  copyStarted: (() => void) | undefined;
  beforeCopyComplete: (() => Promise<void>) | undefined;
  copyCount = 0;

  async createUploadUrl(input: { readonly objectKey: string }) {
    this.signed.push(input.objectKey);
    return {
      url: 'https://storage.test/upload',
      expiresAt: new Date(NOW.getTime() + 300_000),
    };
  }
  async describeObject(
    input: { readonly objectKey: string },
    signal?: AbortSignal,
  ) {
    this.operationSignals.push(signal);
    this.events.push('describe');
    this.described.push(input.objectKey);
    const object = this.objects.get(input.objectKey);
    return object === undefined
      ? undefined
      : { contentType: object.contentType, byteSize: object.byteSize };
  }
  async copyObject(
    input: {
      readonly sourceObjectKey: string;
      readonly destinationObjectKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    this.operationSignals.push(signal);
    this.events.push('copy');
    this.copyCount += 1;
    this.copyStarted?.();
    await this.beforeCopyComplete?.();
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

function deferred() {
  const state: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (state.resolve === undefined) throw new Error('deferred is not ready');
      state.resolve();
    },
  };
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

  it('serializes concurrent completion across a staging re-PUT', async () => {
    const h = setup();
    const { stagingKey } = await openUpload(h);
    const copyStarted = deferred();
    const allowCopy = deferred();
    const secondWaiting = deferred();
    const assetRecorded = deferred();
    const allowCommit = deferred();
    h.storage.copyStarted = () => copyStarted.resolve();
    h.storage.beforeCopyComplete = () => allowCopy.promise;
    h.repository.onSecondCompletionWaiting = () => secondWaiting.resolve();
    h.repository.afterAssetRecorded = async () => {
      assetRecorded.resolve();
      await allowCommit.promise;
    };
    h.storage.objects.set(stagingKey, stored());

    const firstCompletion = h.service.completeUpload({
      context: h.context,
      assetId: ASSET_ID,
    });
    await copyStarted.promise;
    const secondCompletion = h.service.completeUpload({
      context: h.context,
      assetId: ASSET_ID,
    });
    await secondWaiting.promise;
    allowCopy.resolve();
    await assetRecorded.promise;
    h.storage.objects.set(stagingKey, stored('replacement bytes'));
    allowCommit.resolve();

    const [first, second] = await Promise.all([
      firstCompletion,
      secondCompletion,
    ]);
    expect(h.storage.copyCount).toBe(1);
    expect(h.storage.objects.get(h.intent.objectKey)?.bytes).toBe(
      'accepted bytes',
    );
    expect(second).toEqual({ asset: first.asset, created: false });
    expect(h.repository.asset).toEqual(first.asset);
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
    expect(h.repository.rejectedCount).toBe(1);
    expect(h.repository.intent).toBeUndefined();
    expect(h.repository.asset).toBeUndefined();
  });

  it('uses one deadline signal for every storage call inside completion', async () => {
    const h = setup();
    const { stagingKey } = await openUpload(h);
    h.storage.objects.set(stagingKey, stored());

    await h.service.completeUpload({ context: h.context, assetId: ASSET_ID });

    const [deadlineSignal] = h.storage.operationSignals;
    expect(h.storage.operationSignals).toEqual([
      deadlineSignal,
      deadlineSignal,
      deadlineSignal,
    ]);
    expect(deadlineSignal).toBeDefined();
    expect(deadlineSignal).not.toBe(h.context.signal);
  });

  it('does not copy after the completion deadline has aborted', async () => {
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    try {
      const h = setup();
      const { stagingKey } = await openUpload(h);
      h.storage.objects.set(stagingKey, stored());

      await expect(
        h.service.completeUpload({ context: h.context, assetId: ASSET_ID }),
      ).rejects.toMatchObject({
        code: 'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
      });
      expect(h.storage.operationSignals).toHaveLength(1);
      expect(h.storage.operationSignals[0]?.aborted).toBe(true);
      expect(h.storage.copyCount).toBe(0);
    } finally {
      timeout.mockRestore();
    }
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
    expect(h.repository.rejectedCount).toBe(1);
    expect(h.repository.intent).toBeUndefined();
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

async function rejectedCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="rate_limit"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

describe('SpeakingAudioUploadService Organization ceilings (#374)', () => {
  const request = (h: ReturnType<typeof setup>, byteSize = 1_024) =>
    h.service.requestUpload({
      context: h.context,
      contentType: 'audio/wav',
      byteSize,
    });

  it('refuses a new intent once the Organization holds the maximum open ones', async () => {
    const h = setup();
    h.repository.holding = {
      openIntents: SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX,
      issuedInWindow: 0,
      storedBytes: 0,
    };

    await expect(request(h)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(h.repository.intent).toBeUndefined();
  });

  it('refuses an intent that would exceed the Organization storage ceiling', async () => {
    const h = setup();
    h.repository.holding = {
      openIntents: 0,
      issuedInWindow: 0,
      storedBytes: SPEAKING_AUDIO_ORG_STORED_BYTES_MAX - 10,
    };

    await expect(request(h, 1_024)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      retryable: false,
    });
    expect(h.repository.intent).toBeUndefined();
  });

  it('accepts an intent that fits exactly within the storage ceiling', async () => {
    const h = setup();
    h.repository.holding = {
      openIntents: 0,
      issuedInWindow: 0,
      storedBytes: SPEAKING_AUDIO_ORG_STORED_BYTES_MAX - 1_024,
    };

    await expect(request(h)).resolves.toMatchObject({ byteSize: 1_024 });
    expect(h.repository.intent).toBeDefined();
  });

  it('counts the refusal on the rejected metric', async () => {
    const h = setup();
    h.repository.holding = {
      openIntents: SPEAKING_AUDIO_ORG_OPEN_INTENT_MAX,
      issuedInWindow: 0,
      storedBytes: 0,
    };
    const before = await rejectedCount();

    await expect(request(h)).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    await expect(rejectedCount()).resolves.toBe(before + 1);
  });
});

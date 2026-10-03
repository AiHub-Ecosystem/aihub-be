import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import type { SpeakingAudioUploadIntent } from '@/modules/speaking/domain/speaking-audio-asset';

import { runSpeakingAudioUploadSweepCommand } from './speaking-audio-upload-sweep';

const NOW = new Date('2026-10-03T04:00:00.000Z');
const GRACE_MS = 24 * 60 * 60 * 1000;

function intent(
  n: number,
  overrides: Partial<SpeakingAudioUploadIntent> = {},
): SpeakingAudioUploadIntent {
  const assetId = `aud_01J000000000000000000000${String(n).padStart(2, '0')}`;
  const createdAt = new Date(NOW.getTime() - 2 * GRACE_MS);
  return {
    assetId,
    organizationId: 'org_test',
    endUserId: `student-${n}`,
    environment: n % 2 === 0 ? 'sandbox' : 'production',
    objectKey: `orgs/org_test/speaking/${assetId}/original`,
    contentType: 'audio/wav',
    byteSize: 1_024,
    createdAt,
    expiresAt: new Date(NOW.getTime() - GRACE_MS - 1),
    status: 'open',
    ...overrides,
  };
}

class FakeRepository
  implements
    Pick<
      SpeakingAudioUploadRepositoryPort,
      'listCleanupCandidates' | 'removeCleanupCandidate'
    >
{
  readonly intents: SpeakingAudioUploadIntent[];

  constructor(intents: readonly SpeakingAudioUploadIntent[]) {
    this.intents = [...intents];
  }

  async listCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }) {
    return this.intents
      .filter(
        (candidate) =>
          candidate.status === 'rejected' ||
          candidate.expiresAt <= input.expiredBefore,
      )
      .filter(
        (candidate) =>
          input.after === undefined ||
          candidate.createdAt > input.after.createdAt ||
          (candidate.createdAt.getTime() === input.after.createdAt.getTime() &&
            candidate.assetId > input.after.assetId),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.assetId.localeCompare(right.assetId),
      )
      .slice(0, input.limit);
  }

  async removeCleanupCandidate(input: {
    readonly intent: SpeakingAudioUploadIntent;
    readonly expiredBefore: Date;
  }): Promise<boolean> {
    const index = this.intents.findIndex(
      (candidate) =>
        candidate.assetId === input.intent.assetId &&
        candidate.objectKey === input.intent.objectKey &&
        (candidate.status === 'rejected' ||
          candidate.expiresAt <= input.expiredBefore),
    );
    if (index < 0) return false;
    this.intents.splice(index, 1);
    return true;
  }
}

class FakeStorage implements SpeakingAudioAssetStoragePort {
  readonly deleted: string[] = [];
  readonly fail = new Set<string>();

  async createUploadUrl(): Promise<never> {
    throw new Error('not used by cleanup');
  }

  async describeObject(): Promise<never> {
    throw new Error('not used by cleanup');
  }

  async deleteObject(input: {
    readonly objectKey: string;
  }): Promise<void> {
    if (this.fail.has(input.objectKey)) throw new Error('storage unavailable');
    this.deleted.push(input.objectKey);
  }
}

function run(intents: readonly SpeakingAudioUploadIntent[], dryRun: boolean) {
  const repository = Object.assign(new FakeRepository(intents), {
    closed: false,
    close: async function close() {
      this.closed = true;
    },
  });
  const storage = new FakeStorage();
  const output: string[] = [];
  const result = runSpeakingAudioUploadSweepCommand({
    databaseUrl: 'postgres://unused',
    dryRun,
    repository,
    storage,
    emit: (line) => output.push(line),
    now: () => NOW,
  });
  return { result, repository, storage, output };
}

describe('Speaking Audio upload cleanup command', () => {
  it('applies the expiry grace, retries rejected deletes, and emits no keys', async () => {
    const expired = intent(1);
    const tooYoung = intent(2, {
      expiresAt: new Date(NOW.getTime() - GRACE_MS + 1),
    });
    const rejected = intent(3, { status: 'rejected', expiresAt: NOW });
    const { result, repository, storage, output } = run(
      [expired, tooYoung, rejected],
      false,
    );
    storage.fail.add(expired.objectKey);

    await expect(result).resolves.toEqual({
      scanned: 2,
      eligible: 2,
      deleted: 1,
      failed: 1,
      dryRun: false,
    });
    expect(storage.deleted).toEqual([rejected.objectKey]);
    expect(repository.intents).toEqual([expired, tooYoung]);
    expect(repository.closed).toBe(true);
    expect(output).toEqual([
      JSON.stringify({
        scanned: 2,
        eligible: 2,
        deleted: 1,
        failed: 1,
        dryRun: false,
      }),
    ]);
    expect(output.join('')).not.toContain(expired.objectKey);
    expect(output.join('')).not.toContain(expired.endUserId);
  });

  it('dry-runs every page without deleting or consuming intents', async () => {
    const candidates = Array.from({ length: 501 }, (_, index) =>
      intent(index + 1, { status: 'rejected' }),
    );
    const { result, repository, storage } = run(candidates, true);

    await expect(result).resolves.toMatchObject({
      scanned: 501,
      eligible: 501,
      deleted: 0,
      failed: 0,
      dryRun: true,
    });
    expect(repository.intents).toHaveLength(501);
    expect(storage.deleted).toEqual([]);
  });
});

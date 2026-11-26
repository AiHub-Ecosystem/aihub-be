import type {
  AvatarStoragePort,
  ListedAvatarObject,
} from '@/modules/avatar/application/avatar-storage.port';
import {
  AVATAR_SWEEP_GRACE_MS,
  avatarObjectKey,
} from '@/modules/avatar/domain/avatar';
import { InMemoryAvatarRepository } from '@/modules/avatar/testing/in-memory-avatar.repository';

import { runAvatarRecoveryCommand } from './avatar-recovery';
import type {
  AvatarRecoveryState,
  AvatarRecoveryStateStore,
} from './avatar-recovery-state';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - AVATAR_SWEEP_GRACE_MS - 1_000);

function keyOf(n: number): string {
  return avatarObjectKey(
    `usr_01J000000000000000000000${String(n).padStart(2, '0')}`,
    'ava_01J00000000000000000000001',
  );
}

class FakeStorage implements AvatarStoragePort {
  readonly final: ListedAvatarObject[] = [];
  readonly deleted: string[] = [];
  readonly failDelete = new Set<string>();
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
  async createUploadUrl(): Promise<never> {
    throw new Error('unused');
  }
  publicUrl(): string {
    throw new Error('unused');
  }
  async readStagingObject(): Promise<never> {
    throw new Error('unused');
  }
  async putFinalObject(): Promise<never> {
    throw new Error('unused');
  }
  async describeStagingObject(): Promise<never> {
    throw new Error('unused');
  }
  async describeFinalObject(): Promise<never> {
    throw new Error('unused');
  }
  async deleteObject(objectKey: string): Promise<void> {
    if (this.failDelete.has(objectKey)) throw new Error('delete failed');
    this.deleted.push(objectKey);
  }
  async deleteStagingObject(): Promise<void> {}
  async *listObjects(
    _prefix: string,
    startAfter?: string,
  ): AsyncIterable<ListedAvatarObject> {
    yield* this.final.filter(
      (object) => startAfter === undefined || object.objectKey > startAfter,
    );
  }
  async *listStagingObjects(): AsyncIterable<ListedAvatarObject> {}
}

type TestStateStore = AvatarRecoveryStateStore & {
  readonly writes: AvatarRecoveryState[];
  readonly clears: number;
};

function memoryStateStore(initial?: AvatarRecoveryState): TestStateStore {
  let state = initial;
  const writes: AvatarRecoveryState[] = [];
  let clears = 0;
  return {
    writes,
    get clears() {
      return clears;
    },
    async read() {
      return state;
    },
    async write(next) {
      state = next;
      writes.push(next);
    },
    async clear() {
      state = undefined;
      clears += 1;
    },
  };
}

function run(
  storage: FakeStorage,
  stateStore: AvatarRecoveryStateStore,
  lines: string[],
  maxListed = 500,
) {
  const repository = Object.assign(new InMemoryAvatarRepository(), {
    close: async () => undefined,
  });
  return runAvatarRecoveryCommand({
    databaseUrl: 'postgres://unused',
    scope: 'production',
    now: NOW,
    maxListed,
    repository,
    storage,
    stateStore,
    emit: (line) => lines.push(line),
  });
}

describe('runAvatarRecoveryCommand', () => {
  it('saves a partial pass and clears the state when the backlog is done', async () => {
    const storage = new FakeStorage();
    storage.final.push(
      { objectKey: keyOf(1), lastModified: OLD },
      { objectKey: keyOf(2), lastModified: OLD },
    );
    const stateStore = memoryStateStore();
    const lines: string[] = [];

    const first = await run(storage, stateStore, lines, 1);
    expect(first.partial).toBe(true);
    expect(await stateStore.read('production')).toMatchObject({
      scope: 'production',
      finalCursor: keyOf(1),
    });
    expect(lines.join('\n')).toContain('"status":"partial"');
    expect(lines.join('\n')).not.toContain(keyOf(1));

    const second = await run(storage, stateStore, lines, 1);
    expect(second.deleted).toBe(1);
    expect(storage.deleted).toEqual([keyOf(1), keyOf(2)]);

    const third = await run(storage, stateStore, lines, 1);
    expect(third.partial).toBe(false);
    expect(await stateStore.read('production')).toBeUndefined();
    expect(lines.join('\n')).toContain('"status":"completed"');
  });

  it('refuses state from another deployment before deleting anything', async () => {
    const storage = new FakeStorage();
    storage.final.push({ objectKey: keyOf(1), lastModified: OLD });
    const stateStore = memoryStateStore({
      scope: 'sandbox',
      updatedAt: NOW.toISOString(),
    });

    await expect(run(storage, stateStore, [])).rejects.toThrow(
      'avatar recovery state belongs to another deployment',
    );
    expect(storage.deleted).toEqual([]);
  });

  it('keeps a failed delete at the cursor for the next pass', async () => {
    const storage = new FakeStorage();
    storage.final.push({ objectKey: keyOf(1), lastModified: OLD });
    storage.failDelete.add(keyOf(1));
    const stateStore = memoryStateStore();
    const lines: string[] = [];

    const first = await run(storage, stateStore, lines);
    expect(first).toMatchObject({ failed: 1, deleted: 0 });
    const state = await stateStore.read('production');
    expect(state).toMatchObject({ scope: 'production' });
    expect(state).not.toHaveProperty('finalCursor');

    storage.failDelete.clear();
    const second = await run(storage, stateStore, lines);
    expect(second).toMatchObject({ failed: 0, deleted: 1 });
    expect(lines.join('\n')).not.toContain(keyOf(1));
  });
});

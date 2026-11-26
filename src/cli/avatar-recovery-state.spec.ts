import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileAvatarRecoveryStateStore } from './avatar-recovery-state';

describe('createFileAvatarRecoveryStateStore', () => {
  it('persists one cursor pair per deployment and clears it on completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aihub-avatar-recovery-'));
    try {
      const store = createFileAvatarRecoveryStateStore(directory);
      await expect(store.read('production')).resolves.toBeUndefined();

      await store.write({
        scope: 'production',
        finalCursor: 'users/usr_a/avatar/ava_a/original',
        updatedAt: '2026-10-02T12:00:00.000Z',
      });

      await expect(store.read('production')).resolves.toMatchObject({
        scope: 'production',
        finalCursor: 'users/usr_a/avatar/ava_a/original',
      });
      await expect(store.read('sandbox')).resolves.toBeUndefined();

      await store.clear('production');
      await expect(store.read('production')).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('refuses a state file it cannot read rather than guessing a cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aihub-avatar-recovery-'));
    try {
      await writeFile(
        join(directory, 'aihub-avatar-recovery-production.json'),
        '{"scope":"production"}',
      );
      await expect(
        createFileAvatarRecoveryStateStore(directory).read('production'),
      ).rejects.toThrow('avatar recovery state is invalid');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

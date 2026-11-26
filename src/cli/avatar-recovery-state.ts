import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { internalError } from '@/common/errors/app-error';

export type AvatarRecoveryScope = 'production' | 'sandbox';

/**
 * One cursor pair per deployment. Cursors are object keys, so the file is
 * operator-only (0600) and never printed in a routine log line.
 */
export interface AvatarRecoveryState {
  readonly scope: AvatarRecoveryScope;
  readonly finalCursor?: string;
  readonly stagingCursor?: string;
  readonly updatedAt: string;
}

export interface AvatarRecoveryStateStore {
  read(scope: AvatarRecoveryScope): Promise<AvatarRecoveryState | undefined>;
  write(state: AvatarRecoveryState): Promise<void>;
  clear(scope: AvatarRecoveryScope): Promise<void>;
}

function statePath(directory: string, scope: string): string {
  return join(directory, `aihub-avatar-recovery-${scope}.json`);
}

interface RawRecoveryState {
  readonly scope?: unknown;
  readonly updatedAt?: unknown;
  readonly finalCursor?: unknown;
  readonly stagingCursor?: unknown;
}

function parseState(value: string): AvatarRecoveryState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw internalError('avatar recovery state is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw internalError('avatar recovery state is invalid');
  }
  const record = parsed as RawRecoveryState;
  if (
    (record.scope !== 'production' && record.scope !== 'sandbox') ||
    typeof record.updatedAt !== 'string' ||
    (record.finalCursor !== undefined &&
      typeof record.finalCursor !== 'string') ||
    (record.stagingCursor !== undefined &&
      typeof record.stagingCursor !== 'string')
  ) {
    throw internalError('avatar recovery state is invalid');
  }
  const scope = record.scope;
  const finalCursor =
    typeof record.finalCursor === 'string' ? record.finalCursor : undefined;
  const stagingCursor =
    typeof record.stagingCursor === 'string' ? record.stagingCursor : undefined;
  return {
    scope,
    updatedAt: record.updatedAt,
    ...(finalCursor === undefined ? {} : { finalCursor }),
    ...(stagingCursor === undefined ? {} : { stagingCursor }),
  };
}

/** A process exits between passes; the file is what the next pass resumes. */
export function createFileAvatarRecoveryStateStore(
  directory: string = tmpdir(),
): AvatarRecoveryStateStore {
  return {
    async read(scope) {
      let value: string;
      try {
        value = await readFile(statePath(directory, scope), 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return undefined;
        throw error;
      }
      return parseState(value);
    },
    async write(state) {
      const target = statePath(directory, state.scope);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, target);
    },
    async clear(scope) {
      await rm(statePath(directory, scope), { force: true });
    },
  };
}

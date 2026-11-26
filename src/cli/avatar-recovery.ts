import { internalError } from '@/common/errors/app-error';
import {
  AvatarOrphanSweep,
  type AvatarRecoveryResult,
  type AvatarRepositoryPort,
  type AvatarStoragePort,
} from '@/modules/avatar/public/avatar-sweep';

import {
  type AvatarRecoveryScope,
  type AvatarRecoveryStateStore,
  createFileAvatarRecoveryStateStore,
} from './avatar-recovery-state';
import { createCliAvatarStorage } from './avatar-storage';
import { openAvatarOperatorRepository } from './avatar-sweep';
import { runOperatorCommand } from './operator-command-context';

export interface AvatarRecoveryCliInput {
  readonly databaseUrl: string;
  readonly scope: AvatarRecoveryScope;
  readonly now?: Date;
  readonly clockSource?: 'process' | 'database';
  readonly maxListed?: number;
  readonly maxDeletes?: number;
  readonly repository?: AvatarRepositoryPort & { close(): Promise<void> };
  readonly storage?: AvatarStoragePort & { close(): Promise<void> };
  readonly stateStore?: AvatarRecoveryStateStore;
  readonly emit?: (line: string) => void;
}

/**
 * Drains a reviewed Avatar backlog one bounded, resumable pass at a time.
 * The scheduled sweep stays fail-closed; this path exists only when an
 * operator has reviewed the dry-run counts and confirmed the target scope.
 */
export async function runAvatarRecoveryCommand(
  input: AvatarRecoveryCliInput,
): Promise<AvatarRecoveryResult> {
  if (input.databaseUrl.trim().length === 0) {
    throw internalError('DATABASE_URL is required');
  }
  const stateStore = input.stateStore ?? createFileAvatarRecoveryStateStore();
  const state = await stateStore.read(input.scope);
  if (state !== undefined && state.scope !== input.scope) {
    throw internalError('avatar recovery state belongs to another deployment');
  }

  const repository =
    input.repository ?? (await openAvatarOperatorRepository(input.databaseUrl));
  const storage = input.storage ?? createCliAvatarStorage();
  const sweep = new AvatarOrphanSweep(repository, storage);

  const { result } = await runOperatorCommand(
    repository,
    () => input.now ?? new Date(),
    ({ occurredAt }) =>
      sweep.runRecovery({
        now: occurredAt,
        ...(state?.finalCursor === undefined
          ? {}
          : { finalCursor: state.finalCursor }),
        ...(state?.stagingCursor === undefined
          ? {}
          : { stagingCursor: state.stagingCursor }),
        ...(input.maxListed === undefined
          ? {}
          : { maxListed: input.maxListed }),
        ...(input.maxDeletes === undefined
          ? {}
          : { maxDeletes: input.maxDeletes }),
      }),
    storage,
  );

  if (result.partial) {
    await stateStore.write({
      scope: input.scope,
      updatedAt: new Date().toISOString(),
      ...(result.nextFinalCursor === undefined
        ? {}
        : { finalCursor: result.nextFinalCursor }),
      ...(result.nextStagingCursor === undefined
        ? {}
        : { stagingCursor: result.nextStagingCursor }),
    });
  } else {
    await stateStore.clear(input.scope);
  }

  const emit = input.emit ?? console.log;
  emit(
    JSON.stringify({
      event: 'avatar_recovery_pass',
      runtime_scope: input.scope,
      status: result.partial ? 'partial' : 'completed',
      scanned: result.scanned,
      unrecognised: result.unrecognised,
      orphaned: result.orphaned,
      deleted: result.deleted,
      failed: result.failed,
      staging_scanned: result.stagingScanned,
      staging_unrecognised: result.stagingUnrecognised,
      staging_eligible: result.stagingEligible,
      staging_deleted: result.stagingDeleted,
      staging_failed: result.stagingFailed,
      cutoff_source: input.clockSource ?? 'process',
    }),
  );
  return result;
}
